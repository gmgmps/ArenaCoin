"use strict";

const crypto = require("crypto");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { getApps, initializeApp } = require("firebase-admin/app");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");

if (!getApps().length) initializeApp();

const db = getFirestore();
const telegramBotToken = defineSecret("TELEGRAM_BOT_TOKEN");

const REGION = "us-central1";
const MAX_ENERGY = 100;
const SPIN_COST = 20;
const RECHARGE_INTERVAL_MS = 60 * 1000;
const MAX_INIT_DATA_AGE_SECONDS = 24 * 60 * 60;
const MAX_TAP_REWARD = 50;
const TAP_REWARD_COOLDOWN_MS = 8 * 1000;
const MEMORY_REWARD_COOLDOWN_MS = 5 * 1000;

const PRIZES = [
  { label: "+10 نقطة", type: "coins", value: 10 },
  { label: "+25 نقطة", type: "coins", value: 25 },
  { label: "+50 نقطة", type: "coins", value: 50 },
  { label: "+100 نقطة", type: "coins", value: 100 },
  { label: "+20 طاقة", type: "energy", value: 20 },
  { label: "+30 طاقة", type: "energy", value: 30 },
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

function timingSafeEqualHex(expected, actual) {
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function verifyTelegramInitData(initData) {
  if (typeof initData !== "string" || !initData) {
    throw new ClientError("Missing Telegram init data", 401);
  }

  const values = new URLSearchParams(initData);
  const receivedHash = values.get("hash");
  if (!receivedHash) throw new ClientError("Missing Telegram hash", 401);

  values.delete("hash");
  const dataCheckString = [...values.entries()]
    .sort(([firstKey], [secondKey]) => firstKey.localeCompare(secondKey))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(telegramBotToken.value())
    .digest();
  const expectedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (!timingSafeEqualHex(expectedHash, receivedHash)) {
    throw new ClientError("Invalid Telegram signature", 401);
  }

  const authDate = Number(values.get("auth_date"));
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(authDate) || authDate > nowSeconds + 300 || nowSeconds - authDate > MAX_INIT_DATA_AGE_SECONDS) {
    throw new ClientError("Telegram session expired. Reopen the app from the bot.", 401);
  }

  try {
    const user = JSON.parse(values.get("user") || "");
    if (!Number.isFinite(user.id)) throw new Error("Missing user ID");
    return user;
  } catch {
    throw new ClientError("Invalid Telegram user data", 401);
  }
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
  let coins = numberInRange(data?.coins, 0, 0, 1000000000);
  let energy = numberInRange(data?.energy, MAX_ENERGY, 0, MAX_ENERGY);
  let energyUpdatedAt = numberInRange(data?.energyUpdatedAt, now, 0, now);

  if (energy >= MAX_ENERGY) {
    return { coins, energy: MAX_ENERGY, energyUpdatedAt: now };
  }

  const recovered = Math.floor((now - energyUpdatedAt) / RECHARGE_INTERVAL_MS);
  if (recovered > 0) {
    energy = Math.min(MAX_ENERGY, energy + recovered);
    energyUpdatedAt += recovered * RECHARGE_INTERVAL_MS;
  }

  return { coins, energy, energyUpdatedAt };
}

function clientPlayer(player) {
  return {
    coins: player.coins,
    energy: player.energy,
    energyUpdatedAt: player.energyUpdatedAt
  };
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

function recipientIdFromWalletId(value) {
  if (typeof value !== "string") throw new ClientError("Invalid recipient wallet", 400);
  const match = /^AC-(\d{1,20})$/i.exec(value.trim());
  if (!match) throw new ClientError("Invalid recipient wallet", 400);
  return match[1];
}

function transferAmount(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000000000) {
    throw new ClientError("Invalid transfer amount", 400);
  }
  return value;
}

function tapRewardAmount(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TAP_REWARD) {
    throw new ClientError("Invalid caught coin count", 400);
  }
  return value;
}

function enforceRewardCooldown(data, field, now, cooldownMs) {
  const previousRewardAt = numberInRange(data?.[field], 0, 0, now);
  if (previousRewardAt && now - previousRewardAt < cooldownMs) {
    throw new ClientError("Please finish a new game before claiming another reward", 429);
  }
}

function addRewardCoins(player, coins) {
  if (player.coins + coins > 1000000000) {
    throw new ClientError("Balance limit reached", 400);
  }
  player.coins += coins;
}

async function runEndpoint(request, response, operation) {
  try {
    if (request.method !== "POST") throw new ClientError("Use POST", 405);
    const user = verifyTelegramInitData(request.body?.initData);
    const result = await operation(user);
    response.status(200).json(result);
  } catch (error) {
    console.error("ArenaCoin request failed:", error);
    const status = error instanceof ClientError ? error.status : 500;
    const message = error instanceof ClientError ? error.message : "Server error";
    response.status(status).json({ error: message });
  }
}

const options = {
  region: REGION,
  cors: true,
  secrets: [telegramBotToken]
};

exports.bootstrapPlayer = onRequest(options, (request, response) =>
  runEndpoint(request, response, async (telegramUser) => {
    const profile = profileFromTelegram(telegramUser);
    const playerRef = db.collection("players").doc(profile.telegramId);
    let player;

    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(playerRef);
      player = currentPlayer(snapshot.exists ? snapshot.data() : null, Date.now());
      transaction.set(playerRef, documentData(profile, player, !snapshot.exists), { merge: true });
    });

    return { player: clientPlayer(player) };
  })
);

exports.spin = onRequest(options, (request, response) =>
  runEndpoint(request, response, async (telegramUser) => {
    const profile = profileFromTelegram(telegramUser);
    const playerRef = db.collection("players").doc(profile.telegramId);
    const prizeIndex = crypto.randomInt(PRIZES.length);
    const prize = PRIZES[prizeIndex];
    let player;
    let insufficientEnergy = false;

    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(playerRef);
      player = currentPlayer(snapshot.exists ? snapshot.data() : null, Date.now());

      if (player.energy < SPIN_COST) {
        insufficientEnergy = true;
        transaction.set(playerRef, documentData(profile, player, !snapshot.exists), { merge: true });
        return;
      }

      player.energy -= SPIN_COST;
      player.energyUpdatedAt = Date.now();
      if (prize.type === "coins") player.coins += prize.value;
      if (prize.type === "energy") player.energy = Math.min(MAX_ENERGY, player.energy + prize.value);

      transaction.set(
        playerRef,
        {
          ...documentData(profile, player, !snapshot.exists),
          lastSpinAt: FieldValue.serverTimestamp(),
          lastReward: {
            label: prize.label,
            type: prize.type,
            value: prize.value
          }
        },
        { merge: true }
      );
    });

    if (insufficientEnergy) return { player: clientPlayer(player), insufficientEnergy: true };
    return {
      player: clientPlayer(player),
      prize: { index: prizeIndex, ...prize }
    };
  })
);

exports.transfer = onRequest(options, (request, response) =>
  runEndpoint(request, response, async (telegramUser) => {
    const senderProfile = profileFromTelegram(telegramUser);
    const recipientId = recipientIdFromWalletId(request.body?.recipientId);
    const amount = transferAmount(request.body?.amount);
    if (recipientId === senderProfile.telegramId) {
      throw new ClientError("You cannot transfer to your own wallet", 400);
    }

    const senderRef = db.collection("players").doc(senderProfile.telegramId);
    const recipientRef = db.collection("players").doc(recipientId);
    let sender;

    await db.runTransaction(async (transaction) => {
      const [senderSnapshot, recipientSnapshot] = await Promise.all([
        transaction.get(senderRef),
        transaction.get(recipientRef)
      ]);
      const now = Date.now();
      sender = currentPlayer(senderSnapshot.exists ? senderSnapshot.data() : null, now);

      if (!recipientSnapshot.exists) {
        throw new ClientError("Recipient wallet was not found", 404);
      }
      if (sender.coins < amount) {
        throw new ClientError("Insufficient balance", 400);
      }

      const recipient = currentPlayer(recipientSnapshot.data(), now);
      if (recipient.coins + amount > 1000000000) {
        throw new ClientError("Recipient balance limit reached", 400);
      }

      sender.coins -= amount;
      recipient.coins += amount;
      const transferAt = FieldValue.serverTimestamp();

      transaction.set(
        senderRef,
        {
          ...documentData(senderProfile, sender, !senderSnapshot.exists),
          lastTransfer: {
            direction: "sent",
            counterpartyId: recipientId,
            amount,
            at: transferAt
          }
        },
        { merge: true }
      );
      transaction.update(recipientRef, {
        ...recipient,
        updatedAt: FieldValue.serverTimestamp(),
        lastTransfer: {
          direction: "received",
          counterpartyId: senderProfile.telegramId,
          amount,
          at: FieldValue.serverTimestamp()
        }
      });
    });

    return { player: clientPlayer(sender) };
  })
);

exports.claimTapReward = onRequest(options, (request, response) =>
  runEndpoint(request, response, async (telegramUser) => {
    const profile = profileFromTelegram(telegramUser);
    const caughtCoins = tapRewardAmount(request.body?.caughtCoins);
    const playerRef = db.collection("players").doc(profile.telegramId);
    let player;

    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(playerRef);
      const data = snapshot.exists ? snapshot.data() : null;
      const now = Date.now();
      enforceRewardCooldown(data, "lastTapRewardAtMs", now, TAP_REWARD_COOLDOWN_MS);
      player = currentPlayer(data, now);
      addRewardCoins(player, caughtCoins);
      transaction.set(
        playerRef,
        {
          ...documentData(profile, player, !snapshot.exists),
          lastTapRewardAtMs: now,
          lastTapReward: {
            coins: caughtCoins,
            at: FieldValue.serverTimestamp()
          }
        },
        { merge: true }
      );
    });

    return { player: clientPlayer(player), reward: { coins: caughtCoins } };
  })
);

exports.claimMemoryReward = onRequest(options, (request, response) =>
  runEndpoint(request, response, async (telegramUser) => {
    const profile = profileFromTelegram(telegramUser);
    const rewardCoins = crypto.randomInt(1, 21);
    const playerRef = db.collection("players").doc(profile.telegramId);
    let player;

    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(playerRef);
      const data = snapshot.exists ? snapshot.data() : null;
      const now = Date.now();
      enforceRewardCooldown(data, "lastMemoryRewardAtMs", now, MEMORY_REWARD_COOLDOWN_MS);
      player = currentPlayer(data, now);
      addRewardCoins(player, rewardCoins);
      transaction.set(
        playerRef,
        {
          ...documentData(profile, player, !snapshot.exists),
          lastMemoryRewardAtMs: now,
          lastMemoryReward: {
            coins: rewardCoins,
            at: FieldValue.serverTimestamp()
          }
        },
        { merge: true }
      );
    });

    return { player: clientPlayer(player), reward: { coins: rewardCoins } };
  })
);
