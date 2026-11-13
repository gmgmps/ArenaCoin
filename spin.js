"use strict";
const c = require("./_lib/core");

module.exports = c.endpoint(async (telegramUser) => {
  const profile = c.profileFromTelegram(telegramUser);
  const ref = c.playerRef(profile);
  const prizeIndex = c.crypto.randomInt(c.PRIZES.length);
  const prize = c.PRIZES[prizeIndex];
  let player;
  let noRounds = false;

  await c.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    player = c.currentPlayer(snap.exists ? snap.data() : null, now);

    if (!c.useRound(player.rounds, "wheel", now)) {
      noRounds = true;
      tx.set(ref, c.documentData(profile, player, !snap.exists), { merge: true });
      return;
    }

    if (prize.type === "coins") c.addRewardCoins(player, prize.value);
    if (prize.type === "round") c.refundRound(player.rounds, "wheel"); // دورة مجانية

    tx.set(ref, {
      ...c.documentData(profile, player, !snap.exists),
      lastSpinAt: c.FieldValue.serverTimestamp(),
      lastReward: { label: prize.label, type: prize.type, value: prize.value }
    }, { merge: true });
  });

  if (noRounds) return { player: c.clientPlayer(player), noRounds: true };
  return { player: c.clientPlayer(player), prize: { index: prizeIndex, ...prize } };
});
