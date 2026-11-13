"use strict";
const c = require("./_lib/core");

module.exports = c.endpoint(async (telegramUser) => {
  const profile = c.profileFromTelegram(telegramUser);
  const rewardCoins = c.crypto.randomInt(1, 21);
  const ref = c.playerRef(profile);
  let player;

  await c.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : null;
    const now = Date.now();
    c.consumePending(data, "pendingMemoryAtMs", "memory", now);
    player = c.currentPlayer(data, now);
    c.addRewardCoins(player, rewardCoins);
    tx.set(ref, {
      ...c.documentData(profile, player, !snap.exists),
      pendingMemoryAtMs: 0,
      lastMemoryReward: { coins: rewardCoins, at: c.FieldValue.serverTimestamp() }
    }, { merge: true });
  });

  return { player: c.clientPlayer(player), reward: { coins: rewardCoins } };
});
