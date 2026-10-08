const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
setGlobalOptions({ region: "us-central1", maxInstances: 10 });

const FINIVEX_API_KEY = defineSecret("FINIVEX_API_KEY");
const FINIVEX_API_SECRET = defineSecret("FINIVEX_API_SECRET");
const SECRETS = [FINIVEX_API_KEY, FINIVEX_API_SECRET];
const FINIVEX_BASE = "https://gateway.finivex.online/api/pg";
const APP_URL = process.env.APP_URL || "https://example.com/";

// EDIT: your real prices
const PLANS = {
  termly: { label: "GradeFlow – 1 term", amount: 50.0, currency: "USD", days: 120 },
  annual: { label: "GradeFlow – 1 year", amount: 135.0, currency: "USD", days: 365 },
};

// EDIT if GradeFlow links admins to schools differently
async function getSchoolIdForUser(uid) {
  const snap = await db.collection("users").doc(uid).get();
  const schoolId = snap.exists ? snap.get("schoolId") : null;
  if (!schoolId) throw new HttpsError("failed-precondition", "No school linked to this account.");
  return schoolId;
}

function finivexHeaders() {
  return {
    "Content-Type": "application/json",
    "X-API-Key": FINIVEX_API_KEY.value(),
    "X-API-Secret": FINIVEX_API_SECRET.value(),
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
    logger.error("Finivex hosted-checkout failed", { status: res.status, body });
    throw new HttpsError("unavailable", body.errorMessage || "Could not start checkout. Try again.");
  }
  return body.data.redirectUrl;
}

async function finivexGetStatus(transactionId) {
  const url = `${FINIVEX_BASE}/v1/payments/status?transactionId=${encodeURIComponent(transactionId)}`;
  const res = await fetch(url, { headers: finivexHeaders() });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.success) {
    logger.warn("Finivex status lookup failed", { transactionId, status: res.status, body });
    return null;
  }
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

  if (remoteStatus !== "COMPLETED") {
    const terminal = ["FAILED", "CANCELLED", "EXPIRED", "REFUNDED"].includes(remoteStatus);
    if (terminal && payment.status !== remoteStatus) {
      await payRef.update({ status: remoteStatus, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
    return { status: remoteStatus || payment.status };
  }

  const amountOk = Math.abs(Number(remote.amount) - Number(payment.amount)) < 0.01;
  const currencyOk = !remote.currency || remote.currency === payment.currency;
  if (!amountOk || !currencyOk) {
    logger.error("Amount/currency mismatch", { transactionId, remote, payment });
    await payRef.update({ status: "MISMATCH", remote, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return { status: "MISMATCH" };
  }

  await db.runTransaction(async (t) => {
    const fresh = await t.get(payRef);
    if (fresh.get("status") === "COMPLETED") return;
    const schoolRef = db.collection("schools").doc(payment.schoolId);
    const schoolSnap = await t.get(schoolRef);
    const now = Date.now();
    const currentEnd = schoolSnap.get("subscription.paidUntil")?.toMillis?.() || 0;
    const start = Math.max(now, currentEnd);
    const paidUntil = admin.firestore.Timestamp.fromMillis(start + payment.days * 86400000);
    t.update(payRef, {
      status: "COMPLETED",
      paymentMethod: remote.paymentMethod || null,
      processedAt: remote.processedAt || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    t.set(schoolRef, {
      subscription: { plan: payment.plan, paidUntil, active: true, lastPaymentId: transactionId },
    }, { merge: true });
  });

  logger.info("Payment completed", { transactionId, schoolId: payment.schoolId });
  return { status: "COMPLETED" };
}

exports.createCheckout = onCall({ secrets: SECRETS }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Please sign in first.");
  const planId = req.data?.plan;
  const plan = PLANS[planId];
  if (!plan) throw new HttpsError("invalid-argument", "Unknown plan.");

  const schoolId = await getSchoolIdForUser(req.auth.uid);
  const transactionId = `gf_${schoolId}_${Date.now()}`.replace(/[^A-Za-z0-9_-]/g, "");

  await db.collection("payments").doc(transactionId).set({
    transactionId, schoolId, uid: req.auth.uid, plan: planId,
    amount: plan.amount, currency: plan.currency, days: plan.days,
    status: "PENDING", createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const redirectUrl = await finivexCreateHostedCheckout({
    transactionId, amount: plan.amount, currency: plan.currency, description: plan.label,
  });
  return { transactionId, redirectUrl };
});

exports.verifyPayment = onCall({ secrets: SECRETS }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Please sign in first.");
  const transactionId = String(req.data?.transactionId || "");
  if (!transactionId) throw new HttpsError("invalid-argument", "Missing transactionId.");
  const snap = await db.collection("payments").doc(transactionId).get();
  if (!snap.exists) throw new HttpsError("not-found", "Payment not found.");
  if (snap.get("uid") !== req.auth.uid) throw new HttpsError("permission-denied", "Not your payment.");
  return reconcile(transactionId);
});

exports.finivexWebhook = onRequest({ secrets: SECRETS }, async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");
  const transactionId = String(req.body?.transactionId || "");
  if (!/^gf_[A-Za-z0-9_-]+$/.test(transactionId)) return res.status(400).send("Bad transactionId");
  try {
    const result = await reconcile(transactionId);
    logger.info("Webhook handled", { transactionId, result });
    res.status(200).json({ received: true });
  } catch (err) {
    logger.error("Webhook error", { transactionId, err: String(err) });
    res.status(500).send("Error");
  }
});
