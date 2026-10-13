const admin = require("firebase-admin");

if (!admin.apps.length) {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, "\n");
  admin.initializeApp({ credential: admin.credential.cert(sa) });
}
const db = admin.firestore();

const FINIVEX_BASE = "https://gateway.finivex.online/api/pg";
const APP_URL = process.env.APP_URL || "https://scorpio-darkweb.github.io/GradFlow/";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://scorpio-darkweb.github.io";

// EDIT: your real prices
const PLANS = {
  termly: { label: "GradeFlow – 1 term", amount: 99.99, currency: "USD", days: 120 },
  annual: { label: "GradeFlow – 1 year", amount: 299.99, currency: "USD", days: 365 },
};

// EDIT if GradeFlow links admins to schools differently
async function getSchoolIdForUser(uid) {
  const snap = await db.collection("users").doc(uid).get();
  const schoolId = snap.exists ? snap.get("schoolId") : null;
  if (!schoolId) throw httpError(400, "No school linked to this account.");
  return schoolId;
}

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

function cors() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}
function json(status, body) { return { statusCode: status, headers: cors(), body: JSON.stringify(body) }; }

function endpoint(fn) {
  return async (event) => {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors(), body: "" };
    if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
    try {
      const body = event.body ? JSON.parse(event.body) : {};
      return json(200, await fn(event, body));
    } catch (err) {
      console.error(err);
      return json(err.status || 500, { error: err.status ? err.message : "Server error" });
    }
  };
}

async function requireUser(event) {
  const h = event.headers.authorization || event.headers.Authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) throw httpError(401, "Please sign in first.");
  try { return await admin.auth().verifyIdToken(token); }
  catch { throw httpError(401, "Session expired. Please sign in again."); }
}

function finivexHeaders() {
  return {
    "Content-Type": "application/json",
    "X-API-Key": process.env.FINIVEX_API_KEY,
    "X-API-Secret": process.env.FINIVEX_API_SECRET,
  };
}

async function finivexCreateHostedCheckout({ transactionId, amount, currency, description }) {
  const res = await fetch(`${FINIVEX_BASE}/v1/payments/hosted-checkout`, {
    method: "POST",
    headers: finivexHeaders(),
    body: JSON.stringify({
      transactionId, amount, currency, description,
      returnUrl: `${APP_URL}?payment=return&tx=${encodeURIComponent(transactionId)}`,
      cancelUrl: `${APP_URL}?payment=cancel&tx=${encodeURIComponent(transactionId)}`,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.success || !body.data?.redirectUrl) {
    console.error("Finivex hosted-checkout failed", res.status, body);
    throw httpError(502, body.errorMessage || "Could not start checkout. Try again.");
  }
  return body.data.redirectUrl;
}

async function finivexGetStatus(transactionId) {
  const url = `${FINIVEX_BASE}/v1/payments/status?transactionId=${encodeURIComponent(transactionId)}`;
  const res = await fetch(url, { headers: finivexHeaders() });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.success) { console.warn("Finivex status failed", transactionId, res.status, body); return null; }
  return body.data;
}

async function reconcile(transactionId) {
  const payRef = db.collection("payments").doc(transactionId);
  const paySnap = await payRef.get();
  if (!paySnap.exists) return { status: "NOT_FOUND" };
  const payment = paySnap.data();
  if (payment.status === "COMPLETED") return { status: "COMPLETED" };

  const remote = await finivexGetStatus(transactionId);
  if (!remote) return { status: payment.status };
  const remoteStatus = String(remote.status || "").toUpperCase();
  const now = admin.firestore.FieldValue.serverTimestamp();

  if (remoteStatus !== "COMPLETED") {
    const terminal = ["FAILED", "CANCELLED", "EXPIRED", "REFUNDED"].includes(remoteStatus);
    if (terminal && payment.status !== remoteStatus) await payRef.update({ status: remoteStatus, updatedAt: now });
    return { status: remoteStatus || payment.status };
  }

  const amountOk = Math.abs(Number(remote.amount) - Number(payment.amount)) < 0.01;
  const currencyOk = !remote.currency || remote.currency === payment.currency;
  if (!amountOk || !currencyOk) {
    console.error("Amount/currency mismatch", transactionId, remote, payment);
    await payRef.update({ status: "MISMATCH", remote, updatedAt: now });
    return { status: "MISMATCH" };
  }

  await db.runTransaction(async (t) => {
    const fresh = await t.get(payRef);
    if (fresh.get("status") === "COMPLETED") return;
    const schoolRef = db.collection("schools").doc(payment.schoolId);
    const schoolSnap = await t.get(schoolRef);
    const currentEnd = schoolSnap.get("subscription.paidUntil")?.toMillis?.() || 0;
    const start = Math.max(Date.now(), currentEnd);
    const paidUntil = admin.firestore.Timestamp.fromMillis(start + payment.days * 86400000);
    t.update(payRef, { status: "COMPLETED", paymentMethod: remote.paymentMethod || null, processedAt: remote.processedAt || null, updatedAt: now });
    t.set(schoolRef, { subscription: { plan: payment.plan, paidUntil, active: true, lastPaymentId: transactionId } }, { merge: true });
  });

  console.log("Payment completed", transactionId, payment.schoolId);
  return { status: "COMPLETED" };
}

module.exports = { admin, db, PLANS, getSchoolIdForUser, httpError, endpoint, requireUser, finivexCreateHostedCheckout, reconcile };
