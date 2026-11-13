"use strict";

// 5 جولات لكل لعبة، وتتجدد كلها بعد 5 ساعات من استخدام أول جولة في الدورة
const ROUNDS_PER_PERIOD = 5;
const ROUND_PERIOD_MS = 5 * 60 * 60 * 1000;
const GAMES = ["wheel", "tap", "memory"];

function normRounds(raw, now) {
  const out = {};
  for (const game of GAMES) {
    const r = (raw && raw[game]) || {};
    let left = Number.isFinite(r.left) ? Math.min(ROUNDS_PER_PERIOD, Math.max(0, Math.floor(r.left))) : ROUNDS_PER_PERIOD;
    let resetAt = Number.isFinite(r.resetAt) ? Math.min(Math.max(0, r.resetAt), now + ROUND_PERIOD_MS) : 0;
    if ((resetAt && now >= resetAt) || left >= ROUNDS_PER_PERIOD) {
      left = ROUNDS_PER_PERIOD;
      resetAt = 0;
    }
    out[game] = { left, resetAt };
  }
  return out;
}

function useRound(rounds, game, now) {
  const r = rounds[game];
  if (!r || r.left <= 0) return false;
  if (r.left === ROUNDS_PER_PERIOD) r.resetAt = now + ROUND_PERIOD_MS;
  r.left -= 1;
  return true;
}

function refundRound(rounds, game) {
  const r = rounds[game];
  r.left = Math.min(ROUNDS_PER_PERIOD, r.left + 1);
  if (r.left >= ROUNDS_PER_PERIOD) r.resetAt = 0;
}

module.exports = { ROUNDS_PER_PERIOD, ROUND_PERIOD_MS, GAMES, normRounds, useRound, refundRound };
