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

bot.on("polling_error", (e) => {
  console.error("Polling error:", e.message);
});

// ===============================
// SETTINGS
// ===============================

const SYMBOL = "XAU/USD";
const INTERVAL = "5min";
const CANDLE_MS = 5 * 60 * 1000;
const CANDLE_LIMIT = 150;

const SIGNAL_COOLDOWN = 30 * 60 * 1000; // 30 minutes

const RR = 2.0;

// Telegram users who started the bot
const subscribers = new Set();

// Optional: set CHAT_ID in Render > Environment so you stay
// subscribed after restarts / sleep.
if (process.env.CHAT_ID) {
  subscribers.add(Number(process.env.CHAT_ID));
}

// Prevent duplicate signal
let lastSignalKey = "";
let lastSignalTime = 0;
let lastCheckedCandle = 0;

let engineRunning = true;

// Status shown by the "Signal Status" button
const status = {
  lastCheck: 0,
  lastCandle: 0,
  lastResult: "Not checked yet",
  lastError: null,
  checks: 0,
  errors: 0
};

const MAIN_KEYBOARD = {
  reply_markup: {
    keyboard: [[{ text: "📡 Signal Status" }]],
    resize_keyboard: true
  }
};

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
    lastCheck: status.lastCheck || null,
    lastResult: status.lastResult,
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

Engine: ${engineRunning ? "RUNNING 🟢" : "STOPPED 🔴"}

Tap *📡 Signal Status* below to check the engine anytime.`,
    { parse_mode: "Markdown", ...MAIN_KEYBOARD }
  );
});

bot.onText(/^\/status$/, async (msg) => {
  const chatId = msg.chat.id;

  await bot.sendMessage(
    chatId,
    `📊 ENGINE STATUS

Engine: ${engineRunning ? "🟢 RUNNING" : "🔴 STOPPED"}
Symbol: ${SYMBOL}
Timeframe: ${INTERVAL}
Subscribers: ${subscribers.size}

Last signal:
${lastSignalKey || "None yet"}`,
    MAIN_KEYBOARD
  );
});

bot.onText(/^\/test$/, async (msg) => {
  const chatId = msg.chat.id;

  await bot.sendMessage(
    chatId,
    `✅ TEST MESSAGE

Telegram connection is working.

🟡 XAUUSD Signal Engine
⏱ 5M
🧠 BOS + FVG + OB`,
    MAIN_KEYBOARD
  );
});

// ---------- Signal Status button ----------

function ago(ms) {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
}

async function sendSignalStatus(chatId) {
  const cooldownLeft = lastSignalTime
    ? Math.max(
        0,
        Math.ceil((SIGNAL_COOLDOWN - (Date.now() - lastSignalTime)) / 60000)
      )
    : 0;

  await bot.sendMessage(
    chatId,
    `📡 SIGNAL CHECK STATUS

Engine: ${engineRunning ? "🟢 RUNNING" : "🔴 STOPPED"}
Last check: ${ago(status.lastCheck)}
Last candle: ${
      status.lastCandle
        ? new Date(status.lastCandle).toISOString()
        : "none"
    }
Result: ${status.lastResult}
Data error: ${status.lastError || "none"}

Checks: ${status.checks} | Errors: ${status.errors}
Last signal: ${lastSignalKey || "None yet"}
Cooldown left: ${cooldownLeft} min`,
    MAIN_KEYBOARD
  );
}

bot.onText(/^\/signalstatus$/, (msg) => sendSignalStatus(msg.chat.id));
bot.onText(/^📡 Signal Status$/, (msg) => sendSignalStatus(msg.chat.id));

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

    const candles = response.data.values
      .map(c => ({
        // datetime is UTC: force UTC parsing
        time: new Date(c.datetime.replace(" ", "T") + "Z").getTime(),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close)
      }))
      .filter(c =>
        Number.isFinite(c.time) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close)
      )
      .sort((a, b) => a.time - b.time)
      // keep CLOSED candles only (drop the one still forming)
      .filter(c => c.time + CANDLE_MS <= Date.now());

    if (candles.length < 30) {
      throw new Error("Not enough closed candles");
    }

    status.lastError = null;
    return candles;

  } catch (error) {
    const msg =
      error.response?.data?.message || error.message || "Unknown error";

    status.lastError = msg;

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

    // Bullish FVG: current low > high of candle two candles earlier
    if (right.low > left.high) {
      return {
        low: left.high,
        high: right.low,
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

    // Bearish FVG: current high < low of candle two candles earlier
    if (right.high < left.low) {
      return {
        low: right.high,
        high: left.low,
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

  // Last candle is now truly the latest CLOSED candle
  const i = candles.length - 1;

  const current = candles[i];
  const previous = candles[i - 1];

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

      let touched = false;

      for (let j = Math.max(0, i - 4); j < i; j++) {
        if (candleTouchesZone(candles[j], zone)) {
          touched = true;
          break;
        }
      }

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

      for (let j = Math.max(0, i - 4); j < i; j++) {
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
  const emoji = signal.direction === "BUY" ? "🟢" : "🔴";

  const message = `
${emoji} *XAUUSD ${signal.direction} SIGNAL*

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
    status.lastResult = "Signal found but no subscribers (send /start)";
    return;
  }

  for (const chatId of subscribers) {
    try {
      await bot.sendMessage(chatId, message, {
        parse_mode: "Markdown"
      });

      console.log(`📨 Signal sent to ${chatId}`);
    } catch (error) {
      console.error(`Telegram error for ${chatId}:`, error.message);
    }
  }
}

// ===============================
// ENGINE LOOP
// ===============================

async function runEngine() {
  if (!engineRunning) return;

  console.log("🔎 Checking XAUUSD...");

  status.lastCheck = Date.now();
  status.checks++;

  const candles = await getCandles();

  if (!candles) {
    status.errors++;
    status.lastResult = "❌ Market data unavailable";
    return;
  }

  const latest = candles[candles.length - 1];

  if (!latest) return;

  // Don't analyze same candle repeatedly
  if (latest.time === lastCheckedCandle) {
    status.lastResult = "Waiting for next 5M candle to close";
    return;
  }

  lastCheckedCandle = latest.time;
  status.lastCandle = latest.time;

  console.log(
    `🕯 New closed 5M candle: ${new Date(latest.time).toISOString()}`
  );

  const signal = analyze(candles);

  if (!signal) {
    status.lastResult = "No valid setup";
    console.log("⏳ No valid setup.");
    return;
  }

  const signalKey =
    `${signal.direction}_${signal.candleTime}_${signal.entry}`;

  const now = Date.now();

  if (signalKey === lastSignalKey) {
    status.lastResult = "Duplicate signal blocked";
    console.log("🚫 Duplicate signal blocked.");
    return;
  }

  if (lastSignalTime && now - lastSignalTime < SIGNAL_COOLDOWN) {
    status.lastResult = "Setup found, cooldown active";
    console.log("⏳ Signal cooldown active.");
    return;
  }

  lastSignalKey = signalKey;
  lastSignalTime = now;
  status.lastResult = `🚨 ${signal.direction} signal sent`;

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

// Check once per 5M candle (288 API calls/day instead of 1440)
function scheduleNext() {
  const wait = CANDLE_MS - (Date.now() % CANDLE_MS) + 15000; // 15s after close

  setTimeout(async () => {
    try {
      await runEngine();
    } catch (e) {
      console.error("Engine error:", e.message);
      status.lastResult = "Engine error: " + e.message;
    }
    scheduleNext();
  }, wait);
}

runEngine();
scheduleNext();
