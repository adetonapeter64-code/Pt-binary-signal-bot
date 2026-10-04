const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN is missing");
  process.exit(1);
}

if (!TWELVE_DATA_API_KEY) {
  console.error("❌ TWELVE_DATA_API_KEY is missing");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, {
  polling: true
});

// ===============================
// SETTINGS
// ===============================

const SYMBOL = "XAU/USD";
const INTERVAL = "5min";
const CANDLE_LIMIT = 150;

const CHECK_EVERY = 60 * 1000; // 1 minute
const SIGNAL_COOLDOWN = 30 * 60 * 1000; // 30 minutes

const RR = 2.0;

// Telegram users who started the bot
const subscribers = new Set();

// Prevent duplicate signal
let lastSignalKey = "";
let lastSignalTime = 0;
let lastCheckedCandle = "";

let engineRunning = true;

// ===============================
// EXPRESS SERVER
// ===============================

app.get("/", (req, res) => {
  res.send(`
    <h2>🟡 XAUUSD Telegram Signal Engine</h2>
    <p>Status: ${engineRunning ? "RUNNING 🟢" : "STOPPED 🔴"}</p>
    <p>Symbol: ${SYMBOL}</p>
    <p>Timeframe: ${INTERVAL}</p>
    <p>Subscribers: ${subscribers.size}</p>
  `);
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    engine: engineRunning,
    symbol: SYMBOL,
    timeframe: INTERVAL,
    subscribers: subscribers.size,
    lastSignal: lastSignalKey || null
  });
});

app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});

// ===============================
// TELEGRAM COMMANDS
// ===============================

bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;

  subscribers.add(chatId);

  await bot.sendMessage(
    chatId,
    `🟡 *XAUUSD SMC SIGNAL BOT*

Welcome.

📊 Market: XAU/USD
⏱ Timeframe: 5 Minutes
🧠 Strategy: BOS + FVG + Order Block
🎯 Risk/Reward: 1:2

The engine will automatically send signals when a valid setup is confirmed.

🟢 BUY
🔴 SELL

Engine: ${engineRunning ? "RUNNING 🟢" : "STOPPED 🔴"}`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/^\/status$/, async (msg) => {
  const chatId = msg.chat.id;

  await bot.sendMessage(
    chatId,
    `📊 *ENGINE STATUS*

Engine: ${engineRunning ? "🟢 RUNNING" : "🔴 STOPPED"}
Symbol: ${SYMBOL}
Timeframe: ${INTERVAL}
Subscribers: ${subscribers.size}

Last signal:
${lastSignalKey || "None yet"}`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/^\/test$/, async (msg) => {
  const chatId = msg.chat.id;

  await bot.sendMessage(
    chatId,
    `✅ *TEST MESSAGE*

Telegram connection is working.

🟡 XAUUSD Signal Engine
⏱ 5M
🧠 BOS + FVG + OB`,
    { parse_mode: "Markdown" }
  );
});

// ===============================
// GET MARKET DATA
// ===============================

async function getCandles() {
  try {
    const url = "https://api.twelvedata.com/time_series";

    const response = await axios.get(url, {
      params: {
        symbol: SYMBOL,
        interval: INTERVAL,
        outputsize: CANDLE_LIMIT,
        timezone: "UTC",
        apikey: TWELVE_DATA_API_KEY
      },
      timeout: 15000
    });

    if (!response.data) {
      throw new Error("Empty API response");
    }

    if (response.data.status === "error") {
      throw new Error(response.data.message || "Twelve Data error");
    }

    if (!response.data.values || response.data.values.length < 20) {
      throw new Error("Not enough candle data");
    }

    return response.data.values
      .map(c => ({
        time: new Date(c.datetime).getTime(),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close)
      }))
      .filter(c =>
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close)
      )
      .sort((a, b) => a.time - b.time);

  } catch (error) {
    console.error(
      "❌ Market data error:",
      error.response?.data || error.message
    );

    return null;
  }
}

// ===============================
// BASIC HELPERS
// ===============================

function bullish(c) {
  return c.close > c.open;
}

function bearish(c) {
  return c.close < c.open;
}

function body(c) {
  return Math.abs(c.close - c.open);
}

function range(c) {
  return c.high - c.low;
}

function roundPrice(price) {
  return Number(price.toFixed(2));
}

// ===============================
// SWING DETECTION
// ===============================

function isSwingHigh(candles, i) {
  if (i < 2 || i >= candles.length - 2) return false;

  return (
    candles[i].high > candles[i - 1].high &&
    candles[i].high > candles[i - 2].high &&
    candles[i].high > candles[i + 1].high &&
    candles[i].high > candles[i + 2].high
  );
}

function isSwingLow(candles, i) {
  if (i < 2 || i >= candles.length - 2) return false;

  return (
    candles[i].low < candles[i - 1].low &&
    candles[i].low < candles[i - 2].low &&
    candles[i].low < candles[i + 1].low &&
    candles[i].low < candles[i + 2].low
  );
}

function findRecentSwingHigh(candles, endIndex) {
  for (let i = endIndex - 2; i >= Math.max(2, endIndex - 25); i--) {
    if (isSwingHigh(candles, i)) {
      return candles[i].high;
    }
  }

  return null;
}

function findRecentSwingLow(candles, endIndex) {
  for (let i = endIndex - 2; i >= Math.max(2, endIndex - 25); i--) {
    if (isSwingLow(candles, i)) {
      return candles[i].low;
    }
  }

  return null;
}

// ===============================
// FAIR VALUE GAP
// ===============================

function findBullishFVG(candles, confirmationIndex) {
  for (
    let i = confirmationIndex - 1;
    i >= Math.max(2, confirmationIndex - 8);
    i--
  ) {
    const left = candles[i - 2];
    const middle = candles[i - 1];
    const right = candles[i];

    if (!left || !middle || !right) continue;

    // Bullish FVG:
    // current low > candle two candles earlier high
    if (right.low > left.high) {
      const zoneLow = left.high;
      const zoneHigh = right.low;

      return {
        low: zoneLow,
        high: zoneHigh,
        index: i,
        type: "bullish"
      };
    }
  }

  return null;
}

function findBearishFVG(candles, confirmationIndex) {
  for (
    let i = confirmationIndex - 1;
    i >= Math.max(2, confirmationIndex - 8);
    i--
  ) {
    const left = candles[i - 2];
    const middle = candles[i - 1];
    const right = candles[i];

    if (!left || !middle || !right) continue;

    // Bearish FVG:
    // current high < candle two candles earlier low
    if (right.high < left.low) {
      const zoneLow = right.high;
      const zoneHigh = left.low;

      return {
        low: zoneLow,
        high: zoneHigh,
        index: i,
        type: "bearish"
      };
    }
  }

  return null;
}

// ===============================
// ORDER BLOCK
// ===============================

function findBullishOrderBlock(candles, index) {
  for (
    let i = index - 1;
    i >= Math.max(0, index - 8);
    i--
  ) {
    if (bearish(candles[i])) {
      return {
        low: candles[i].low,
        high: candles[i].high,
        index: i,
        type: "bullish"
      };
    }
  }

  return null;
}

function findBearishOrderBlock(candles, index) {
  for (
    let i = index - 1;
    i >= Math.max(0, index - 8);
    i--
  ) {
    if (bullish(candles[i])) {
      return {
        low: candles[i].low,
        high: candles[i].high,
        index: i,
        type: "bearish"
      };
    }
  }

  return null;
}

// ===============================
// ZONE TOUCH
// ===============================

function candleTouchesZone(candle, zone) {
  return (
    candle.low <= zone.high &&
    candle.high >= zone.low
  );
}

// ===============================
// STRATEGY ENGINE
// ===============================

function analyze(candles) {
  if (!candles || candles.length < 30) {
    return null;
  }

  // Last candle is treated as the latest closed candle
  const i = candles.length - 1;

  const current = candles[i];
  const previous = candles[i - 1];

  // Avoid weak tiny candles
  if (range(current) <= 0) {
    return null;
  }

  // ======================================
  // BUY
  // ======================================

  const previousSwingHigh = findRecentSwingHigh(candles, i - 1);

  if (
    previousSwingHigh &&
    current.close > previousSwingHigh &&
    bullish(current)
  ) {
    const fvg = findBullishFVG(candles, i);
    const ob = findBullishOrderBlock(candles, i);

    if (fvg || ob) {
      const zone = fvg || ob;

      // We need a pullback/interaction with the zone.
      // Look at the previous 1-4 candles.
      let touched = false;

      for (
        let j = Math.max(0, i - 4);
        j < i;
        j++
      ) {
        if (candleTouchesZone(candles[j], zone)) {
          touched = true;
          break;
        }
      }

      // Current candle must also show bullish confirmation.
      if (
        touched &&
        bullish(current) &&
        current.close > previous.close
      ) {
        const entry = current.close;

        const structureLow = Math.min(
          zone.low,
          candles[i - 1].low,
          candles[i - 2].low
        );

        const sl = structureLow - 0.30;

        const risk = entry - sl;

        if (risk > 0) {
          const tp = entry + risk * RR;

          return {
            direction: "BUY",
            entry: roundPrice(entry),
            sl: roundPrice(sl),
            tp: roundPrice(tp),
            reason: fvg
              ? "BOS + Bullish FVG + Confirmation"
              : "BOS + Bullish Order Block + Confirmation",
            candleTime: current.time
          };
        }
      }
    }
  }

  // ======================================
  // SELL
  // ======================================

  const previousSwingLow = findRecentSwingLow(candles, i - 1);

  if (
    previousSwingLow &&
    current.close < previousSwingLow &&
    bearish(current)
  ) {
    const fvg = findBearishFVG(candles, i);
    const ob = findBearishOrderBlock(candles, i);

    if (fvg || ob) {
      const zone = fvg || ob;

      let touched = false;

      for (
        let j = Math.max(0, i - 4);
        j < i;
        j++
      ) {
        if (candleTouchesZone(candles[j], zone)) {
          touched = true;
          break;
        }
      }

      if (
        touched &&
        bearish(current) &&
        current.close < previous.close
      ) {
        const entry = current.close;

        const structureHigh = Math.max(
          zone.high,
          candles[i - 1].high,
          candles[i - 2].high
        );

        const sl = structureHigh + 0.30;

        const risk = sl - entry;

        if (risk > 0) {
          const tp = entry - risk * RR;

          return {
            direction: "SELL",
            entry: roundPrice(entry),
            sl: roundPrice(sl),
            tp: roundPrice(tp),
            reason: fvg
              ? "BOS + Bearish FVG + Confirmation"
              : "BOS + Bearish Order Block + Confirmation",
            candleTime: current.time
          };
        }
      }
    }
  }

  return null;
}

// ===============================
// SEND SIGNAL
// ===============================

async function sendSignal(signal) {
  const emoji = signal.direction === "BUY"
    ? "🟢"
    : "🔴";

  const side = signal.direction === "BUY"
    ? "BUY"
    : "SELL";

  const message = `
${emoji} *XAUUSD ${side} SIGNAL*

━━━━━━━━━━━━━━━━━━

📊 *Market:* XAU/USD
⏱ *Timeframe:* 5 Minutes

📍 *Entry:* ${signal.entry}
🛑 *Stop Loss:* ${signal.sl}
🎯 *Take Profit:* ${signal.tp}

📈 *Risk/Reward:* 1:${RR}

🧠 *Setup:*
${signal.reason}

━━━━━━━━━━━━━━━━━━

⚠️ Risk management is required.
`;

  if (subscribers.size === 0) {
    console.log("⚠️ No Telegram subscribers.");
    return;
  }

  for (const chatId of subscribers) {
    try {
      await bot.sendMessage(chatId, message, {
        parse_mode: "Markdown"
      });

      console.log(`📨 Signal sent to ${chatId}`);
    } catch (error) {
      console.error(
        `Telegram error for ${chatId}:`,
        error.message
      );
    }
  }
}

// ===============================
// ENGINE LOOP
// ===============================

async function runEngine() {
  if (!engineRunning) return;

  console.log("🔎 Checking XAUUSD...");

  const candles = await getCandles();

  if (!candles) {
    return;
  }

  const latest = candles[candles.length - 1];

  if (!latest) return;

  // Don't analyze same candle repeatedly
  if (latest.time === lastCheckedCandle) {
    return;
  }

  lastCheckedCandle = latest.time;

  console.log(
    `🕯 New 5M candle: ${new Date(latest.time).toISOString()}`
  );

  const signal = analyze(candles);

  if (!signal) {
    console.log("⏳ No valid setup.");
    return;
  }

  const signalKey =
    `${signal.direction}_${signal.candleTime}_${signal.entry}`;

  const now = Date.now();

  // Duplicate protection
  if (signalKey === lastSignalKey) {
    console.log("🚫 Duplicate signal blocked.");
    return;
  }

  // Cooldown
  if (
    lastSignalTime &&
    now - lastSignalTime < SIGNAL_COOLDOWN
  ) {
    console.log("⏳ Signal cooldown active.");
    return;
  }

  lastSignalKey = signalKey;
  lastSignalTime = now;

  console.log(
    `🚨 SIGNAL: ${signal.direction} Entry=${signal.entry} SL=${signal.sl} TP=${signal.tp}`
  );

  await sendSignal(signal);
}

// ===============================
// START ENGINE
// ===============================

console.log("=================================");
console.log("🟡 XAUUSD SMC SIGNAL ENGINE");
console.log("=================================");
console.log("📊 Market: XAU/USD");
console.log("⏱ Timeframe: 5M");
console.log("🧠 BOS + FVG + ORDER BLOCK");
console.log("🎯 RR: 1:2");
console.log("=================================");

// Run immediately
runEngine();

// Then check every minute
setInterval(runEngine, CHECK_EVERY);
