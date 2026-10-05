const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const axios = require("axios");

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

const SYMBOL = "XAU/USD";
const INTERVAL = "5min";
const CANDLE_LIMIT = 150;

// ===============================
// STRATEGY SETTINGS
// ===============================

const SWING = 2;
const ATR_PERIOD = 14;

const MIN_ATR = 0.8;
const BREAK_BUFFER_ATR = 0.05;
const MIN_BODY_ATR = 0.20;

const TP1_RR = 1.5;
const TP2_RR = 2.0;

const COOLDOWN_CANDLES = 3;

// ===============================
// BOT STATE
// ===============================

let subscribers = new Set();

let lastProcessedCandle = null;
let lastSignalCandle = null;
let lastSignalDirection = null;

let lastStatus = "Starting...";
let lastSignal = null;

// ===============================
// FORMAT
// ===============================

function fmt(value) {
  return Number(value).toFixed(2);
}

// ===============================
// FETCH XAUUSD DATA
// ===============================

async function fetchCandles() {

  const url = "https://api.twelvedata.com/time_series";

  const response = await axios.get(url, {
    params: {
      symbol: SYMBOL,
      interval: INTERVAL,
      outputsize: CANDLE_LIMIT,
      apikey: TWELVE_DATA_API_KEY,
      format: "JSON"
    },
    timeout: 15000
  });

  if (response.data.status === "error") {
    throw new Error(
      response.data.message || "Twelve Data returned an error"
    );
  }

  if (!Array.isArray(response.data.values)) {
    throw new Error("No XAUUSD candle data returned");
  }

  return response.data.values
    .map(candle => ({
      time: new Date(candle.datetime).getTime(),
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close)
    }))
    .filter(candle =>
      Number.isFinite(candle.time) &&
      Number.isFinite(candle.open) &&
      Number.isFinite(candle.high) &&
      Number.isFinite(candle.low) &&
      Number.isFinite(candle.close)
    )
    .sort((a, b) => a.time - b.time);
}

// ===============================
// TRUE RANGE
// ===============================

function trueRange(current, previous) {

  return Math.max(
    current.high - current.low,
    Math.abs(current.high - previous.close),
    Math.abs(current.low - previous.close)
  );
}

// ===============================
// ATR
// ===============================

function calculateATR(candles, period = ATR_PERIOD) {

  if (candles.length < period + 1) {
    return null;
  }

  const ranges = [];

  for (let i = 1; i < candles.length; i++) {

    ranges.push(
      trueRange(
        candles[i],
        candles[i - 1]
      )
    );
  }

  const recent = ranges.slice(-period);

  return recent.reduce(
    (sum, value) => sum + value,
    0
  ) / recent.length;
}

// ===============================
// FIND SWING HIGH / LOW
// ===============================

function findSwings(candles) {

  const highs = [];
  const lows = [];

  for (
    let i = SWING;
    i < candles.length - SWING;
    i++
  ) {

    let isHigh = true;
    let isLow = true;

    for (
      let j = 1;
      j <= SWING;
      j++
    ) {

      if (
        candles[i].high <= candles[i - j].high ||
        candles[i].high < candles[i + j].high
      ) {
        isHigh = false;
      }

      if (
        candles[i].low >= candles[i - j].low ||
        candles[i].low > candles[i + j].low
      ) {
        isLow = false;
      }
    }

    if (isHigh) {
      highs.push({
        index: i,
        price: candles[i].high
      });
    }

    if (isLow) {
      lows.push({
        index: i,
        price: candles[i].low
      });
    }
  }

  return {
    highs,
    lows
  };
}

// ===============================
// MARKET BIAS
// ===============================

function getBias(highs, lows) {

  if (
    highs.length < 2 ||
    lows.length < 2
  ) {
    return "NEUTRAL";
  }

  const previousHigh =
    highs[highs.length - 2].price;

  const latestHigh =
    highs[highs.length - 1].price;

  const previousLow =
    lows[lows.length - 2].price;

  const latestLow =
    lows[lows.length - 1].price;

  if (
    latestHigh > previousHigh &&
    latestLow > previousLow
  ) {
    return "BULLISH";
  }

  if (
    latestHigh < previousHigh &&
    latestLow < previousLow
  ) {
    return "BEARISH";
  }

  return "NEUTRAL";
}

// ===============================
// CANDLE AGE
// ===============================

function candlesSince(candles, timestamp) {

  const index = candles.findIndex(
    candle => candle.time === timestamp
  );

  if (index === -1) {
    return 999;
  }

  return (
    candles.length -
    1 -
    index
  );
}

// ===============================
// ANALYZE MARKET
// ===============================

function analyzeMarket(candles) {

  const now = Date.now();

  // Only use CLOSED M5 candles.
  const completed = candles.filter(
    candle =>
      candle.time + 5 * 60 * 1000 <= now
  );

  if (completed.length < 60) {

    return {
      signal: null,
      reason: "Waiting for enough completed M5 candles"
    };
  }

  const current =
    completed[completed.length - 1];

  const previous =
    completed.slice(0, -1);

  const atr =
    calculateATR(completed);

  if (!atr) {

    return {
      signal: null,
      reason: "ATR unavailable",
      candle: current
    };
  }

  if (atr < MIN_ATR) {

    return {
      signal: null,
      reason: "Market volatility too low",
      candle: current
    };
  }

  const {
    highs,
    lows
  } = findSwings(previous);

  if (
    highs.length < 2 ||
    lows.length < 2
  ) {

    return {
      signal: null,
      reason: "Waiting for market structure",
      candle: current
    };
  }

  const bias =
    getBias(highs, lows);

  const resistance =
    highs[highs.length - 1].price;

  const support =
    lows[lows.length - 1].price;

  const candleBody =
    Math.abs(
      current.close -
      current.open
    );

  const bullish =
    current.close >
    current.open;

  const bearish =
    current.close <
    current.open;

  const bodyConfirmed =
    candleBody >=
    atr * MIN_BODY_ATR;

  const buyBreak =
    current.close >
    resistance +
    atr * BREAK_BUFFER_ATR;

  const sellBreak =
    current.close <
    support -
    atr * BREAK_BUFFER_ATR;

  // ============================
  // BUY
  // ============================

  if (
    bias === "BULLISH" &&
    buyBreak &&
    bullish &&
    bodyConfirmed
  ) {

    const entry =
      current.close;

    const sl =
      Math.min(
        current.low,
        support
      ) -
      atr * 0.15;

    const risk =
      entry - sl;

    if (risk > 0) {

      return {

        candle: current,

        signal: {

          direction: "BUY",

          entry,

          sl,

          tp1:
            entry +
            risk * TP1_RR,

          tp2:
            entry +
            risk * TP2_RR,

          level: resistance,

          atr,

          bias
        }
      };
    }
  }

  // ============================
  // SELL
  // ============================

  if (
    bias === "BEARISH" &&
    sellBreak &&
    bearish &&
    bodyConfirmed
  ) {

    const entry =
      current.close;

    const sl =
      Math.max(
        current.high,
        resistance
      ) +
      atr * 0.15;

    const risk =
      sl - entry;

    if (risk > 0) {

      return {

        candle: current,

        signal: {

          direction: "SELL",

          entry,

          sl,

          tp1:
            entry -
            risk * TP1_RR,

          tp2:
            entry -
            risk * TP2_RR,

          level: support,

          atr,

          bias
        }
      };
    }
  }

  return {

    candle: current,

    signal: null,

    reason:
      `No confirmed setup | Bias: ${bias} | ` +
      `Resistance: ${fmt(resistance)} | ` +
      `Support: ${fmt(support)}`
  };
}

// ===============================
// TELEGRAM SIGNAL MESSAGE
// ===============================

function createSignalMessage(signal) {

  const emoji =
    signal.direction === "BUY"
      ? "🟢"
      : "🔴";

  return (

`${emoji} XAUUSD M5 ${signal.direction} SIGNAL

📍 ENTRY: ${fmt(signal.entry)}

🛑 STOP LOSS: ${fmt(signal.sl)}

🎯 TP1: ${fmt(signal.tp1)}

🎯 TP2: ${fmt(signal.tp2)}

📊 STRATEGY
• M5 Market Structure
• Swing High / Low
• Breakout Confirmation
• Candle Confirmation
• ATR Risk Calculation

📈 BIAS: ${signal.bias}

💧 KEY LEVEL: ${fmt(signal.level)}

📐 ATR: ${fmt(signal.atr)}

⚠️ Use proper risk management.
`
  );
}

// ===============================
// SEND SIGNAL
// ===============================

async function sendSignal(signal) {

  const message =
    createSignalMessage(signal);

  for (
    const chatId of subscribers
  ) {

    try {

      await bot.sendMessage(
        chatId,
        message
      );

    } catch (error) {

      console.error(
        `Telegram error for ${chatId}:`,
        error.message
      );
    }
  }

  lastSignal = {
    ...signal,
    sentAt:
      new Date().toISOString()
  };
}

// ===============================
// MARKET CHECK
// ===============================

async function checkMarket() {

  try {

    const candles =
      await fetchCandles();

    const result =
      analyzeMarket(candles);

    if (!result.candle) {

      lastStatus =
        result.reason;

      return;
    }

    const candleId =
      result.candle.time;

    // Prevent duplicate processing.
    if (
      lastProcessedCandle === candleId
    ) {
      return;
    }

    lastProcessedCandle =
      candleId;

    lastStatus =
      result.reason ||
      "No signal";

    if (!result.signal) {

      console.log(
        `[${new Date().toISOString()}] ` +
        lastStatus
      );

      return;
    }

    // Cooldown.
    if (
      lastSignalCandle !== null
    ) {

      const elapsed =
        candlesSince(
          candles,
          lastSignalCandle
        );

      if (
        elapsed <
        COOLDOWN_CANDLES
      ) {

        console.log(
          "⏳ Signal blocked by cooldown"
        );

        return;
      }
    }

    // Don't repeat same direction.
    if (
      lastSignalDirection ===
      result.signal.direction
    ) {

      console.log(
        "⏳ Same-direction signal blocked"
      );

      return;
    }

    lastSignalCandle =
      candleId;

    lastSignalDirection =
      result.signal.direction;

    lastStatus =
      `${result.signal.direction} signal sent`;

    console.log(
      createSignalMessage(
        result.signal
      )
    );

    await sendSignal(
      result.signal
    );

  } catch (error) {

    lastStatus =
      `Data error: ${error.message}`;

    console.error(
      "❌",
      lastStatus
    );
  }
}

// ===============================
// CHECK EVERY 30 SECONDS
// ===============================

setInterval(
  checkMarket,
  30 * 1000
);

checkMarket();

// ===============================
// TELEGRAM /START
// ===============================

bot.onText(
  /^\/start$/,
  async message => {

    const chatId =
      String(message.chat.id);

    subscribers.add(
      chatId
    );

    await bot.sendMessage(
      chatId,

`🤖 XAUUSD M5 SIGNAL BOT

✅ You are subscribed.

The bot automatically checks XAUUSD every M5 candle.

📊 Strategy:
• Market Structure
• Swing High / Low
• Breakout
• Candle Confirmation
• ATR SL/TP

Commands:

/status
/signal
/stop`
    );
  }
);

// ===============================
// STOP
// ===============================

bot.onText(
  /^\/stop$/,
  async message => {

    const chatId =
      String(message.chat.id);

    subscribers.delete(
      chatId
    );

    await bot.sendMessage(
      chatId,
      "🔕 Signal notifications stopped.\n\nSend /start to subscribe again."
    );
  }
);

// ===============================
// STATUS
// ===============================

bot.onText(
  /^\/status$/,
  async message => {

    await bot.sendMessage(
      message.chat.id,

`🛰 XAUUSD M5 BOT STATUS

${lastStatus}

👥 Subscribers: ${subscribers.size}

📡 Data: Twelve Data

⏱ Checking: Every 30 seconds

🕯 Signals: Closed M5 candles only`
    );
  }
);

// ===============================
// LAST SIGNAL
// ===============================

bot.onText(
  /^\/signal$/,
  async message => {

    if (!lastSignal) {

      await bot.sendMessage(
        message.chat.id,
        "⏳ No confirmed signal has been generated yet."
      );

      return;
    }

    await bot.sendMessage(
      message.chat.id,
      createSignalMessage(
        lastSignal
      )
    );
  }
);

// ===============================
// RENDER HEALTH CHECK
// ===============================

app.get(
  "/",
  (req, res) => {

    res.json({

      ok: true,

      bot:
        "XAUUSD M5 Telegram Signal Bot",

      symbol:
        SYMBOL,

      timeframe:
        "M5",

      status:
        lastStatus
    });
  }
);

// ===============================
// START SERVER
// ===============================

app.listen(
  PORT,
  () => {

    console.log(
      `🚀 Server running on port ${PORT}`
    );

    console.log(
      "📊 XAUUSD M5 signal engine started"
    );
  }
);
