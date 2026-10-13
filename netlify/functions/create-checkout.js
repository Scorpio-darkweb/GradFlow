const g = require("../lib/gradeflow");

exports.handler = g.endpoint(async (event, body) => {
  const user = await g.requireUser(event);
  const planId = body.plan;
  const plan = g.PLANS[planId];
  if (!plan) throw g.httpError(400, "Unknown plan.");

  const schoolId = await g.getSchoolIdForUser(user.uid);
  const transactionId = `gf_${schoolId}_${Date.now()}`.replace(/[^A-Za-z0-9_-]/g, "");

  await g.db.collection("payments").doc(transactionId).set({
    transactionId, schoolId, uid: user.uid, plan: planId,
    amount: plan.amount, currency: plan.currency, days: plan.days,
    status: "PENDING", createdAt: g.admin.firestore.FieldValue.serverTimestamp(),
  });

  const redirectUrl = await g.finivexCreateHostedCheckout({
    transactionId, amount: plan.amount, currency: plan.currency, description: plan.label,
  });
  return { transactionId, redirectUrl };
});
