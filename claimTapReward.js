"use strict";
const c = require("./_lib/core");

module.exports = c.endpoint(async (telegramUser, body) => {
  const profile = c.profileFromTelegram(telegramUser);
  const caught = body.caughtCoins;
  if (!Number.isSafeInteger(caught) || caught < 1 || caught > c.MAX_TAP_REWARD) {
    throw new c.ClientError("Invalid caught coin count", 400);
  }
  const ref = c.playerRef(profile);
  let player;

  await c.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : null;
    const now = Date.now();
    c.consumePending(data, "pendingTapAtMs", "tap", now);
    player = c.currentPlayer(data, now);
    c.addRewardCoins(player, caught);
    tx.set(ref, {
      ...c.documentData(profile, player, !snap.exists),
      pendingTapAtMs: 0,
      lastTapReward: { coins: caught, at: c.FieldValue.serverTimestamp() }
    }, { merge: true });
  });

  return { player: c.clientPlayer(player), reward: { coins: caught } };
});
