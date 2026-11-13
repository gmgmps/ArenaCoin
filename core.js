"use strict";

const crypto = require("crypto");
const { admin, db } = require("./firebaseAdmin");
const { verifyTelegramInitData } = require("./telegram");
const rounds = require("./rounds");

const FieldValue = admin.firestore.FieldValue;

const MAX_BALANCE = 1000000000;
const MAX_TAP_REWARD = 50;
// أقل مدة منطقية للعب قبل قبول المطالبة بالمكافأة
const MIN_PLAY_MS = { tap: 9000, memory: 3000 };

// نفس ترتيب العجلة في index.html بالضبط
const PRIZES = [
  { label: "+10 نقطة", type: "coins", value: 10 },
  { label: "+25 نقطة", type: "coins", value: 25 },
  { label: "+50 نقطة", type: "coins", value: 50 },
  { label: "+100 نقطة", type: "coins", value: 100 },
  { label: "دورة مجانية", type: "round", value: 1 },
  { label: "+150 نقطة", type: "coins", value: 150 },
  { label: "+75 نقطة", type: "coins", value: 75 },
  { label: "+200 نقطة", type: "coins", value: 200 }
];

class ClientError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function numberInRange(value, fallback, min, max) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function text(value, maxLength) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function profileFromTelegram(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ") || "لاعب ArenaCoin";
  return {
    telegramId: String(user.id),
    name: text(name, 128),
    username: text(user.username, 64),
    photoUrl: text(user.photo_url, 512)
  };
}

function currentPlayer(data, now) {
  return {
    coins: numberInRange(data && data.coins, 0, 0, MAX_BALANCE),
    rounds: rounds.normRounds(data && data.rounds, now)
  };
}

function clientPlayer(p) {
  return { coins: p.coins, rounds: p.rounds };
}

function documentData(profile, player, isNew) {
  const data = {
    ...profile,
    ...player,
    updatedAt: FieldValue.serverTimestamp(),
    lastActiveAt: FieldValue.serverTimestamp()
  };
  if (isNew) data.createdAt = FieldValue.serverTimestamp();
  return data;
}

/** يتأكد أن اللاعب بدأ جولة فعلًا وانقضى وقت كافٍ، ثم يغلق الجولة المعلّقة */
function consumePending(data, field, game, now) {
  const startedAt = numberInRange(data && data[field], 0, 0, now);
  if (!startedAt) throw new ClientError("Start a round first", 400);
  if (now - startedAt < MIN_PLAY_MS[game]) throw new ClientError("Round is still in progress", 429);
}

function addRewardCoins(player, coins) {
  if (player.coins + coins > MAX_BALANCE) throw new ClientError("Balance limit reached", 400);
  player.coins += coins;
}

function playerRef(profile) {
  return db.collection("players").doc(profile.telegramId);
}

/** غلاف مشترك: CORS + POST فقط + التحقق من تيليجرام + معالجة الأخطاء */
function endpoint(operation) {
  return async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    try {
      if (req.method !== "POST") throw new ClientError("Use POST", 405);
      const body = req.body || {};
      const user = verifyTelegramInitData(body.initData, process.env.BOT_TOKEN);
      const result = await operation(user, body);
      res.status(200).json(result);
    } catch (error) {
      console.error("ArenaCoin request failed:", error.message);
      const known = error instanceof ClientError;
      const status = known ? error.status : /initData|hash|توقيع|user/.test(error.message) ? 401 : 500;
      res.status(status).json({ error: known ? error.message : status === 401 ? "Unauthorized" : "Server error" });
    }
  };
}

module.exports = {
  crypto, db, FieldValue, endpoint, ClientError, numberInRange,
  MAX_BALANCE, MAX_TAP_REWARD, MIN_PLAY_MS, PRIZES,
  useRound: rounds.useRound, refundRound: rounds.refundRound,
  profileFromTelegram, currentPlayer, clientPlayer, documentData,
  consumePending, addRewardCoins, playerRef
};
