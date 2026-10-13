const g = require("../lib/gradeflow");

exports.handler = g.endpoint(async (event, body) => {
  const user = await g.requireUser(event);
  const { schoolId, school } = await g.getAdminSchool(user.uid);

  const price = g.PLAN_PRICES[school.plan];
  if (!price) throw g.httpError(400, "This school has no valid plan.");
  const months = Number(body.months) || 1;
  if (!g.ALLOWED_MONTHS.includes(months)) throw g.httpError(400, "Choose 1, 3 or 12 months.");

  const amount = price * months;
  const transactionId = `gf_${schoolId}_${Date.now()}`.replace(/[^A-Za-z0-9_-]/g, "");

  await g.db.collection("payments").doc(transactionId).set({
    transactionId,
    schoolId,
    uid: user.uid,
    plan: school.plan,
    months,
    amount,
    currency: "USD",
    days: months * 30,
    status: "PENDING",
    createdAt: g.admin.firestore.FieldValue.serverTimestamp(),
  });

  const redirectUrl = await g.finivexCreateHostedCheckout({
    transactionId,
    amount,
    currency: "USD",
    description: `GradeFlow ${school.plan} – ${months} month${months > 1 ? "s" : ""} (${schoolId})`,
  });

  return { transactionId, redirectUrl };
});
