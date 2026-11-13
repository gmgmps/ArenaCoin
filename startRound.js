"use strict";
const c = require("./_lib/core");

const PENDING_FIELD = { tap: "pendingTapAtMs", memory: "pendingMemoryAtMs" };

// يستهلك جولة من لعبة (اصطد العملة أو تحدي الذاكرة) عند بدء اللعب
module.exports = c.endpoint(async (telegramUser, body) => {
  const field = PENDING_FIELD[body.game];
  if (!field) throw new c.ClientError("Unknown game", 400);

  const profile = c.profileFromTelegram(telegramUser);
  const ref = c.playerRef(profile);
  let player;
  let noRounds = false;

  await c.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    player = c.currentPlayer(snap.exists ? snap.data() : null, now);

    if (!c.useRound(player.rounds, body.game, now)) {
      noRounds = true;
      tx.set(ref, c.documentData(profile, player, !snap.exists), { merge: true });
      return;
    }
    tx.set(ref, { ...c.documentData(profile, player, !snap.exists), [field]: now }, { merge: true });
  });

  return noRounds ? { player: c.clientPlayer(player), noRounds: true } : { player: c.clientPlayer(player) };
});
