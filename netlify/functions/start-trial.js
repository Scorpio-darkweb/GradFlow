// Starts a school's one-time free trial (TRIAL_DAYS days). Only the school's admin can call it,
// and only once per school: never after a trial, a payment, or a manual activation.
const g = require("../lib/gradeflow");

const TRIAL_DAYS = 30;

exports.handler = g.endpoint(async (event) => {
  const user = await g.requireUser(event);
  const { schoolId } = await g.getAdminSchool(user.uid);
  const schoolRef = g.db.collection("gradeflow_schools").doc(schoolId);
  const publicRef = g.db.collection("gradeflow_public").doc(schoolId);

  const trialEndsAt = await g.db.runTransaction(async (t) => {
    const snap = await t.get(schoolRef);
    const s = snap.data() || {};
    if (s.trialUsed || s.trialEndsAt || s.paidUntil || s.lastPaymentId) {
      throw g.httpError(409, "This school has already used its free trial. Choose a payment option to continue.");
    }
    const ends = g.admin.firestore.Timestamp.fromMillis(Date.now() + TRIAL_DAYS * 86400000);
    t.set(schoolRef, { status: "active", paidUntil: ends, trialUsed: true, trialEndsAt: ends }, { merge: true });
    t.set(publicRef, { status: "active", paidUntil: ends }, { merge: true });
    return ends;
  });

  console.log("Trial started", schoolId);
  return { status: "TRIAL", trialEndsAt: trialEndsAt.toMillis() };
});
