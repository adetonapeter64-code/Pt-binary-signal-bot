// ================================================================
// BINARY SIGNAL BOT
// Telegram + Twelve Data
// 5M FVG + Order Block + Trend + Confirmation
// SIGNAL ONLY — NO AUTOMATIC TRADING
// ================================================================

const TelegramBot = require("node-telegram-bot-api");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// =========================
// ENVIRONMENT VARIABLES
// =========================
const BOT_TOKEN = process.env.BOT_TOKEN;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

// =========================
// SETTINGS
// =========================
const TIMEFRAME = "5min";
const CANDLE_LIMIT = 80;
const SCAN_INTERVAL = 60 * 1000;

// Pairs
const PAIRS = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "AUD/USD",
  "USD/CAD",
  "EUR/GBP"
];

// =========================
// BOT
// =========================
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

// =========================
// MEMORY
// =========================
const users = new Set();
const lastSignal = {};
const pendingSignals = {};
const results = {
  wins: 0,
  losses: 0
};

// =========================
// EXPRESS
// =========================
app.get("/", (req, res) => {
  res.send("🚀 Binary Signal Bot is running");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    bot: "Binary Signal Bot",
    timeframe: TIMEFRAME,
    pairs: PAIRS
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// ================================================================
// TELEGRAM MENU
// ================================================================

function mainMenu() {
  return {
    reply_markup: {
      keyboard: [
        ["📡 GET SIGNAL", "📊 MARKET"],
        ["📈 PERFORMANCE", "💱 PAIRS"],
        ["ℹ️ HOW IT WORKS"]
      ],
      resize_keyboard: true
    }
  };
}

// ================================================================
// START
// ================================================================

bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;

  users.add(chatId);

  await bot.sendMessage(
    chatId,
    `
╔════════════════════════════╗
     🚀 BINARY SIGNAL PRO
╚════════════════════════════╝

👋 Welcome!

📊 Timeframe: 5 MIN
🧠 Strategy: SMC
💱 Forex Signals
⚡ Fast Telegram Alerts

━━━━━━━━━━━━━━━━━━━━

🧠 FVG
📦 Order Block
📈 Trend
✅ Confirmation Candle

━━━━━━━━━━━━━━━━━━━━

🎯 Signal Type:
🟢 CALL
🔴 PUT

⚠️ SIGNALS ONLY
No automatic trading.

Tap below to begin 👇
`,
    mainMenu()
  );
});

// ================================================================
// BUTTON HANDLER
// ================================================================

bot.on("message", async (msg) => {
  if (!msg.text) return;

  const chatId = msg.chat.id;
  const text = msg.text;

  users.add(chatId);

  if (text === "📡 GET SIGNAL") {
    await sendBestSignal(chatId);
    return;
  }

  if (text === "📊 MARKET") {
    await showMarket(chatId);
    return;
  }

  if (text === "📈 PERFORMANCE") {
    await showPerformance(chatId);
    return;
  }

  if (text === "💱 PAIRS") {
    await bot.sendMessage(
      chatId,
      `
💱 MONITORED PAIRS

1️⃣ EUR/USD
2️⃣ GBP/USD
3️⃣ USD/JPY
4️⃣ AUD/USD
5️⃣ USD/CAD
6️⃣ EUR/GBP

⏱️ Timeframe: 5M
`
    );
    return;
  }

  if (text === "ℹ️ HOW IT WORKS") {
    await bot.sendMessage(
      chatId,
      `
🧠 HOW THE SIGNAL ENGINE WORKS

The bot looks for:

1️⃣ Market direction
2️⃣ Fair Value Gap
3️⃣ Order Block
4️⃣ Price reaction
5️⃣ Confirmation candle

Only when enough conditions agree will the bot generate:

🟢 CALL
or
🔴 PUT

⏳ Expiry: 5 minutes

⚠️ A signal is NOT a guarantee of profit.
`
    );
  }
});

// ================================================================
// TWELVE DATA
// ================================================================

async function getCandles(symbol) {
  const url =
    "https://api.twelvedata.com/time_series" +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${TIMEFRAME}` +
    `&outputsize=${CANDLE_LIMIT}` +
    `&timezone=UTC` +
    `&apikey=${TWELVE_DATA_API_KEY}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.status === "error") {
    throw new Error(data.message || "Twelve Data error");
  }

  if (!Array.isArray(data.values)) {
    throw new Error("No candle data received");
  }

  return data.values
    .map(c => ({
      time: c.datetime,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close)
    }))
    .reverse();
}

// ================================================================
// HELPERS
// ================================================================

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

function averageBody(candles, count = 10) {
  const arr = candles.slice(-count);

  if (!arr.length) return 0;

  return (
    arr.reduce((sum, c) => sum + body(c), 0) / arr.length
  );
}

// ================================================================
// TREND
// ================================================================

function getTrend(candles) {
  const recent = candles.slice(-12);

  let bullishScore = 0;
  let bearishScore = 0;

  for (let i = 1; i < recent.length; i++) {
    if (recent[i].close > recent[i - 1].close) {
      bullishScore++;
    }

    if (recent[i].close < recent[i - 1].close) {
      bearishScore++;
    }
  }

  if (bullishScore >= bearishScore + 3) {
    return "BULLISH";
  }

  if (bearishScore >= bullishScore + 3) {
    return "BEARISH";
  }

  return "NEUTRAL";
}

// ================================================================
// FVG DETECTION
// ================================================================

function detectFVG(candles) {
  if (candles.length < 5) return null;

  const a = candles[candles.length - 4];
  const b = candles[candles.length - 3];
  const c = candles[candles.length - 2];

  // Bullish FVG
  if (c.low > a.high) {
    return {
      type: "BULLISH",
      low: a.high,
      high: c.low
    };
  }

  // Bearish FVG
  if (c.high < a.low) {
    return {
      type: "BEARISH",
      low: c.high,
      high: a.low
    };
  }

  return null;
}

// ================================================================
// ORDER BLOCK
// ================================================================

function detectOrderBlock(candles) {
  if (candles.length < 6) return null;

  const previous = candles[candles.length - 3];
  const impulse = candles[candles.length - 2];

  const avg = averageBody(candles, 10);

  // Bullish OB:
  // bearish candle followed by strong bullish impulse
  if (
    bearish(previous) &&
    bullish(impulse) &&
    body(impulse) > avg * 1.25
  ) {
    return {
      type: "BULLISH",
      low: previous.low,
      high: previous.high
    };
  }

  // Bearish OB
  if (
    bullish(previous) &&
    bearish(impulse) &&
    body(impulse) > avg * 1.25
  ) {
    return {
      type: "BEARISH",
      low: previous.low,
      high: previous.high
    };
  }

  return null;
}

// ================================================================
// CONFIRMATION CANDLE
// ================================================================

function confirmation(candles) {
  const c = candles[candles.length - 2];

  const avg = averageBody(candles, 10);

  if (body(c) < avg * 0.8) {
    return "WEAK";
  }

  if (
    bullish(c) &&
    c.close > c.open &&
    body(c) >= avg
  ) {
    return "BULLISH";
  }

  if (
    bearish(c) &&
    c.close < c.open &&
    body(c) >= avg
  ) {
    return "BEARISH";
  }

  return "WEAK";
}

// ================================================================
// SIGNAL ENGINE
// ================================================================

function analyze(symbol, candles) {
  if (candles.length < 20) {
    return null;
  }

  const trend = getTrend(candles);
  const fvg = detectFVG(candles);
  const ob = detectOrderBlock(candles);
  const confirm = confirmation(candles);

  let bullishScore = 0;
  let bearishScore = 0;

  // Trend
  if (trend === "BULLISH") bullishScore += 2;
  if (trend === "BEARISH") bearishScore += 2;

  // FVG
  if (fvg?.type === "BULLISH") bullishScore += 2;
  if (fvg?.type === "BEARISH") bearishScore += 2;

  // Order Block
  if (ob?.type === "BULLISH") bullishScore += 2;
  if (ob?.type === "BEARISH") bearishScore += 2;

  // Confirmation
  if (confirm === "BULLISH") bullishScore += 2;
  if (confirm === "BEARISH") bearishScore += 2;

  const total = Math.max(bullishScore, bearishScore);

  // Require strong agreement
  if (total < 6) {
    return null;
  }

  let direction;

  if (bullishScore > bearishScore) {
    direction = "CALL";
  } else if (bearishScore > bullishScore) {
    direction = "PUT";
  } else {
    return null;
  }

  const confidence = Math.min(
    95,
    60 + total * 4
  );

  const candle = candles[candles.length - 1];

  return {
    symbol,
    direction,
    confidence,
    entry: candle.close,
    trend,
    fvg: fvg?.type || "NONE",
    orderBlock: ob?.type || "NONE",
    confirmation: confirm,
    timestamp: new Date().toISOString()
  };
}

// ================================================================
// FORMAT SIGNAL
// ================================================================

function signalMessage(signal) {
  const direction =
    signal.direction === "CALL"
      ? "🟢 CALL"
      : "🔴 PUT";

  const trendEmoji =
    signal.trend === "BULLISH"
      ? "📈"
      : signal.trend === "BEARISH"
        ? "📉"
        : "➡️";

  return `
╔════════════════════════════╗
       🚨 BINARY SIGNAL 🚨
╚════════════════════════════╝

💱 PAIR
⭐ ${signal.symbol}

📊 DIRECTION
${direction}

⏱️ TIMEFRAME
5 MINUTES

🎯 EXPIRY
5 MINUTES

📍 ENTRY
NEXT CANDLE

━━━━━━━━━━━━━━━━━━━━

${trendEmoji} TREND
${signal.trend}

💎 FVG
${signal.fvg === "BULLISH"
    ? "🟢 Bullish FVG"
    : signal.fvg === "BEARISH"
      ? "🔴 Bearish FVG"
      : "⚪ None"}

📦 ORDER BLOCK
${signal.orderBlock === "BULLISH"
    ? "🟢 Bullish OB"
    : signal.orderBlock === "BEARISH"
      ? "🔴 Bearish OB"
      : "⚪ None"}

🕯️ CONFIRMATION
${signal.confirmation === "BULLISH"
    ? "🟢 Bullish"
    : signal.confirmation === "BEARISH"
      ? "🔴 Bearish"
      : "⚪ Weak"}

━━━━━━━━━━━━━━━━━━━━

🔥 CONFIDENCE
⭐ ${signal.confidence}%

⚡ WAIT FOR THE NEW CANDLE

━━━━━━━━━━━━━━━━━━━━
🧠 SMC BINARY ENGINE
⚠️ MANAGE YOUR RISK
━━━━━━━━━━━━━━━━━━━━
`;
}

// ================================================================
// SEND BEST SIGNAL
// ================================================================

async function sendBestSignal(chatId) {
  await bot.sendMessage(
    chatId,
    "🔎 Scanning the market...\n\n📊 Checking 5M candles\n🧠 Checking FVG\n📦 Checking Order Blocks\n🕯️ Checking confirmation..."
  );

  const signals = [];

  for (const pair of PAIRS) {
    try {
      const candles = await getCandles(pair);
      const signal = analyze(pair, candles);

      if (signal) {
        signals.push(signal);
      }
    } catch (error) {
      console.error(`❌ ${pair}:`, error.message);
    }
  }

  if (!signals.length) {
    await bot.sendMessage(
      chatId,
      `
⏳ NO HIGH-QUALITY SETUP

I checked all monitored pairs.

🔎 No strong combination of:

📈 Trend
💎 FVG
📦 Order Block
🕯️ Confirmation

was found.

🛡️ NO TRADE IS BETTER THAN A BAD SIGNAL.

Try again on the next 5M candle.
`
    );

    return;
  }

  signals.sort(
    (a, b) => b.confidence - a.confidence
  );

  const best = signals[0];

  const key = `${chatId}_${best.symbol}`;

  // Prevent duplicate signal
  if (lastSignal[key]) {
    const age =
      Date.now() - lastSignal[key];

    if (age < 5 * 60 * 1000) {
      await bot.sendMessage(
        chatId,
        "⏳ This pair already produced a recent signal. Waiting for a fresh setup."
      );

      return;
    }
  }

  lastSignal[key] = Date.now();

  pendingSignals[key] = {
    ...best,
    chatId,
    createdAt: Date.now()
  };

  await bot.sendMessage(
    chatId,
    signalMessage(best)
  );
}

// ================================================================
// MARKET STATUS
// ================================================================

async function showMarket(chatId) {
  await bot.sendMessage(
    chatId,
    "📊 Checking market conditions..."
  );

  let message = `
╔══════════════════════╗
       📊 MARKET SCAN
╚══════════════════════╝
`;

  for (const pair of PAIRS) {
    try {
      const candles = await getCandles(pair);
      const trend = getTrend(candles);

      const emoji =
        trend === "BULLISH"
          ? "🟢"
          : trend === "BEARISH"
            ? "🔴"
            : "⚪";

      message += `\n${emoji} ${pair} — ${trend}`;
    } catch {
      message += `\n⚠️ ${pair} — DATA ERROR`;
    }
  }

  message += `

━━━━━━━━━━━━━━━━━━━━
⏱️ TIMEFRAME: 5M
🧠 SMC ENGINE ACTIVE
`;

  await bot.sendMessage(chatId, message);
}

// ================================================================
// PERFORMANCE
// ================================================================

async function showPerformance(chatId) {
  const total =
    results.wins + results.losses;

  const winRate =
    total === 0
      ? 0
      : ((results.wins / total) * 100).toFixed(1);

  await bot.sendMessage(
    chatId,
    `
╔══════════════════════╗
      📈 PERFORMANCE
╚══════════════════════╝

🏆 WINS
${results.wins}

❌ LOSSES
${results.losses}

📊 TOTAL
${total}

🔥 WIN RATE
${winRate}%

━━━━━━━━━━━━━━━━━━━━

⚠️ Performance starts tracking
after the bot is running.

No historical performance is being
claimed yet.
`
  );
}

// ================================================================
// AUTOMATIC SCANNER
// ================================================================

async function automaticScanner() {
  console.log("🔎 Automatic market scan...");

  for (const chatId of users) {
    try {
      const signals = [];

      for (const pair of PAIRS) {
        const candles = await getCandles(pair);
        const signal = analyze(pair, candles);

        if (signal) {
          signals.push(signal);
        }
      }

      if (!signals.length) continue;

      signals.sort(
        (a, b) => b.confidence - a.confidence
      );

      const best = signals[0];

      if (best.confidence < 76) continue;

      const key = `${chatId}_${best.symbol}`;

      if (lastSignal[key]) {
        const age =
          Date.now() - lastSignal[key];

        if (age < 5 * 60 * 1000) {
          continue;
        }
      }

      lastSignal[key] = Date.now();

      pendingSignals[key] = {
        ...best,
        chatId,
        createdAt: Date.now()
      };

      await bot.sendMessage(
        chatId,
        signalMessage(best)
      );

    } catch (error) {
      console.error(
        "Automatic scan error:",
        error.message
      );
    }
  }
}

// ================================================================
// START AUTOMATIC SCANNER
// ================================================================

setInterval(
  automaticScanner,
  SCAN_INTERVAL
);

console.log("🚀 Binary Signal Bot started");
console.log("⏱️ Timeframe:", TIMEFRAME);
console.log("💱 Pairs:", PAIRS.join(", "));
