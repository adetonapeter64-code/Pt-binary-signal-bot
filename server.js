const TelegramBot = require("node-telegram-bot-api");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

const TIMEZONE = "Africa/Lagos";

// ===============================
// SETTINGS
// ===============================

const ANALYSIS_TIMEFRAME = "5min";
const EXPIRY_MINUTES = 1;

// Scan every 60 seconds to reduce API usage.
const SCAN_INTERVAL = 60 * 1000;
const RESULT_CHECK_INTERVAL = 10 * 1000;

const MIN_CONFIDENCE = 76;
const RISK_PERCENT = 5;

// ===============================
// PAIRS
// ===============================

const PAIRS = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "AUD/USD",
  "USD/CAD",
  "EUR/GBP",
  "NZD/USD",
  "USD/CHF",
  "EUR/JPY",
  "GBP/JPY"
];

// ===============================
// BASIC CHECKS
// ===============================

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN is missing");
  process.exit(1);
}

if (!TWELVE_DATA_API_KEY) {
  console.error("❌ TWELVE_DATA_API_KEY is missing");
  process.exit(1);
}

// ===============================
// TELEGRAM
// ===============================

const bot = new TelegramBot(BOT_TOKEN, {
  polling: true
});

// Users who have started the bot.
// Anyone can use the bot by sending /start.
const users = new Set();

// Active signals
const activeSignals = new Map();

// Daily statistics
const dailyStats = {
  trades: 0,
  wins: 0,
  losses: 0,
  profit: 0,
  loss: 0,
  pairs: {}
};

let lastReportDate = null;

// Prevent duplicate signals on the same setup/candle
const lastSignalCandle = new Map();

// ===============================
// WEB SERVER
// ===============================

app.get("/", (req, res) => {
  res.send("🚨 Binary Signal Pro is running");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    bot: "Binary Signal Pro",
    timezone: TIMEZONE,
    analysis: ANALYSIS_TIMEFRAME,
    expiry: `${EXPIRY_MINUTES}M`,
    users: users.size,
    activeSignals: activeSignals.size
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// ===============================
// TIME
// ===============================

function nigeriaTimeParts() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(new Date());

  const result = {};

  for (const p of parts) {
    if (p.type !== "literal") {
      result[p.type] = p.value;
    }
  }

  return {
    hour: Number(result.hour),
    minute: Number(result.minute),
    second: Number(result.second)
  };
}

function nigeriaDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

// ===============================
// SESSION
// ===============================
//
// ACTIVE:
// 9:00 PM → 8:00 PM next day
//
// BREAK:
// 8:00 PM → 9:00 PM
// ===============================

function currentSessionState() {
  const t = nigeriaTimeParts();
  const minutes = t.hour * 60 + t.minute;

  if (minutes >= 21 * 60 || minutes < 20 * 60) {
    return "ACTIVE";
  }

  return "BREAK";
}

// ===============================
// DAILY RESET
// ===============================

function resetDailyStats() {
  dailyStats.trades = 0;
  dailyStats.wins = 0;
  dailyStats.losses = 0;
  dailyStats.profit = 0;
  dailyStats.loss = 0;
  dailyStats.pairs = {};

  lastSignalCandle.clear();
}

// ===============================
// /START
// ===============================
//
// NO MENU BUTTONS.
// EVERY USER CAN START THE BOT.
// ===============================

bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;

  // Register user
  users.add(chatId);

  console.log(`👤 User registered: ${chatId}`);

  const session = currentSessionState();

  let message = `
🚨 BINARY SIGNAL PRO 🚨

Welcome to the signal engine.

🧠 SMC ANALYSIS
📊 5M TIMEFRAME
⌛ 1M EXPIRY
🔄 CONTINUOUS SCANNING

The engine checks:

📈 Trend
💎 Fair Value Gap
📦 Order Block
💧 Liquidity
🕯 Confirmation

Only sufficiently strong setups can become signals.

🏆 WIN / ❌ LOSS
After every completed trade, the engine scans again.

⚠️ Signals are not guaranteed profits.
`;

  if (session === "ACTIVE") {
    message += `
🟢 STATUS: ACTIVE

🔎 The engine is scanning for the strongest confirmed setup.
`;

  } else {
    message += `
💤 STATUS: BREAK

⏰ Next session starts at 9:00 PM Nigeria time.
`;
  }

  await bot.sendMessage(chatId, message);
});

// ===============================
// OPTIONAL COMMANDS
// ===============================

bot.onText(/^\/signal$/, async (msg) => {
  const chatId = msg.chat.id;

  users.add(chatId);

  await sendBestSignal(chatId);
});

bot.onText(/^\/market$/, async (msg) => {
  const chatId = msg.chat.id;

  users.add(chatId);

  const session = currentSessionState();

  await bot.sendMessage(
    chatId,
    `📊 MARKET STATUS

🕐 Nigeria Time: ${formatNigeriaTime()}

📡 Session: ${
      session === "ACTIVE" ? "🟢 ACTIVE" : "💤 BREAK"
    }

📊 Analysis: ${ANALYSIS_TIMEFRAME.toUpperCase()}

⌛ Expiry: ${EXPIRY_MINUTES}M

💱 Configured Pairs: ${PAIRS.length}

🔄 Continuous Scanning: ON`
  );
});

bot.onText(/^\/results$/, async (msg) => {
  const chatId = msg.chat.id;

  users.add(chatId);

  const total = dailyStats.trades;

  const winRate =
    total === 0
      ? 0
      : ((dailyStats.wins / total) * 100).toFixed(2);

  await bot.sendMessage(
    chatId,
    `📊 TODAY'S RESULTS

🏁 Trades: ${total}

🏆 Wins: ${dailyStats.wins}

❌ Losses: ${dailyStats.losses}

📈 Win Rate: ${winRate}%

💵 Risk Setting: ${RISK_PERCENT}% of Capital

⚠️ Monetary profit/loss is not calculated because the bot does not have access to your Pocket Option balance or payout.`
  );
});

bot.onText(/^\/pairs$/, async (msg) => {
  const chatId = msg.chat.id;

  users.add(chatId);

  await bot.sendMessage(
    chatId,
    `💱 CONFIGURED PAIRS

${PAIRS.map((pair, i) => `${i + 1}. ${pair}`).join("\n")}

🔎 The engine scans all configured pairs and selects the strongest confirmed setup.`
  );
});

bot.onText(/^\/help$/, async (msg) => {
  const chatId = msg.chat.id;

  users.add(chatId);

  await bot.sendMessage(
    chatId,
    `ℹ️ BINARY SIGNAL PRO

Commands:

/start — Start the bot
/signal — Scan for a signal
/market — Market status
/results — Today's results
/pairs — Configured pairs
/help — Help

🔄 The automatic engine continuously scans while the trading session is active.`
  );
});

// ===============================
// TIME FORMAT
// ===============================

function formatNigeriaTime() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  }).format(new Date());
}

// ===============================
// TWELVE DATA
// ===============================

async function getCandles(symbol) {
  const url =
    "https://api.twelvedata.com/time_series" +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${ANALYSIS_TIMEFRAME}` +
    `&outputsize=80` +
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
    throw new Error("No candle data");
  }

  return data.values
    .map((c) => ({
      time: c.datetime,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close)
    }))
    .reverse();
}

// ===============================
// CANDLE FUNCTIONS
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

function averageBody(candles, count = 10) {
  const data = candles.slice(-count);

  if (!data.length) {
    return 0;
  }

  return (
    data.reduce((sum, c) => sum + body(c), 0) /
    data.length
  );
}

// ===============================
// TREND
// ===============================

function getTrend(candles) {
  const recent = candles.slice(-15);

  let up = 0;
  let down = 0;

  for (let i = 1; i < recent.length; i++) {
    if (recent[i].close > recent[i - 1].close) {
      up++;
    }

    if (recent[i].close < recent[i - 1].close) {
      down++;
    }
  }

  if (up >= down + 4) {
    return "BULLISH";
  }

  if (down >= up + 4) {
    return "BEARISH";
  }

  return "NEUTRAL";
}

// ===============================
// FAIR VALUE GAP
// ===============================

function detectFVG(candles) {
  if (candles.length < 5) {
    return null;
  }

  const a = candles[candles.length - 4];
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

// ===============================
// ORDER BLOCK
// ===============================

function detectOrderBlock(candles) {
  if (candles.length < 6) {
    return null;
  }

  const previous = candles[candles.length - 3];
  const impulse = candles[candles.length - 2];

  const avg = averageBody(candles);

  // Bullish OB
  if (
    bearish(previous) &&
    bullish(impulse) &&
    body(impulse) >= avg * 1.25
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
    body(impulse) >= avg * 1.25
  ) {
    return {
      type: "BEARISH",
      low: previous.low,
      high: previous.high
    };
  }

  return null;
}

// ===============================
// LIQUIDITY
// ===============================

function liquidityDirection(candles) {
  const recent = candles.slice(-8);

  if (recent.length < 3) {
    return "NONE";
  }

  const highs = recent.map((c) => c.high);
  const lows = recent.map((c) => c.low);

  const last = recent[recent.length - 1];

  const previousHigh = Math.max(...highs.slice(0, -1));
  const previousLow = Math.min(...lows.slice(0, -1));

  if (last.close > previousHigh) {
    return "BULLISH";
  }

  if (last.close < previousLow) {
    return "BEARISH";
  }

  return "NONE";
}

// ===============================
// CONFIRMATION
// ===============================

function confirmation(candles) {
  if (candles.length < 5) {
    return "WEAK";
  }

  const c = candles[candles.length - 2];
  const avg = averageBody(candles);

  if (body(c) < avg * 0.8) {
    return "WEAK";
  }

  if (bullish(c) && body(c) >= avg) {
    return "BULLISH";
  }

  if (bearish(c) && body(c) >= avg) {
    return "BEARISH";
  }

  return "WEAK";
}

// ===============================
// SMC ANALYSIS
// ===============================

function analyze(symbol, candles) {
  if (candles.length < 20) {
    return null;
  }

  const trend = getTrend(candles);
  const fvg = detectFVG(candles);
  const ob = detectOrderBlock(candles);
  const liquidity = liquidityDirection(candles);
  const confirm = confirmation(candles);

  let buy = 0;
  let sell = 0;

  // Trend
  if (trend === "BULLISH") {
    buy += 2;
  }

  if (trend === "BEARISH") {
    sell += 2;
  }

  // FVG
  if (fvg?.type === "BULLISH") {
    buy += 2;
  }

  if (fvg?.type === "BEARISH") {
    sell += 2;
  }

  // Order Block
  if (ob?.type === "BULLISH") {
    buy += 2;
  }

  if (ob?.type === "BEARISH") {
    sell += 2;
  }

  // Liquidity
  if (liquidity === "BULLISH") {
    buy += 1;
  }

  if (liquidity === "BEARISH") {
    sell += 1;
  }

  // Confirmation
  if (confirm === "BULLISH") {
    buy += 2;
  }

  if (confirm === "BEARISH") {
    sell += 2;
  }

  const score = Math.max(buy, sell);

  // Not strong enough
  if (score < 7) {
    return null;
  }

  let direction;

  if (buy > sell) {
    direction = "BUY";
  } else if (sell > buy) {
    direction = "SELL";
  } else {
    return null;
  }

  const confidence = Math.min(95, 55 + score * 5);

  if (confidence < MIN_CONFIDENCE) {
    return null;
  }

  const latestCandle = candles[candles.length - 1];

  return {
    symbol,
    direction,
    confidence,
    score,
    trend,
    fvg: fvg?.type || "NONE",
    orderBlock: ob?.type || "NONE",
    liquidity,
    confirmation: confirm,
    entry: latestCandle.close,
    candleTime: latestCandle.time,
    createdAt: Date.now()
  };
}

// ===============================
// SIGNAL MESSAGE
// ===============================

function signalMessage(signal) {
  const now = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  }).format(new Date());

  const arrow =
    signal.direction === "BUY"
      ? "🟢 BUY"
      : "🔴 SELL";

  return `🚨 BINARY SIGNAL 🚨

⏱ Trade Time: ${now}

💱 ${signal.symbol} → ${arrow}

⌛ Expiry: 1M

📊 Confidence: ${signal.confidence}%

📈 SIGNAL RULES

💵 Risk: ${RISK_PERCENT}% of Capital

🧠 CONFIRMATION

📈 Trend: ${signal.trend}
💎 FVG: ${signal.fvg}
📦 Order Block: ${signal.orderBlock}
💧 Liquidity: ${signal.liquidity}
🕯 Confirmation: ${signal.confirmation}

🔄 Continuous scanning

⚠️ Confidence is a strategy score, not a guaranteed win probability.`;
}

// ===============================
// SEND SIGNAL
// ===============================

async function sendSignal(chatId, signal) {
  const id =
    `${chatId}_${signal.symbol}_${Date.now()}`;

  activeSignals.set(id, {
    ...signal,
    chatId,
    id,
    expiryAt:
      Date.now() +
      EXPIRY_MINUTES * 60 * 1000
  });

  lastSignalCandle.set(
    `${chatId}_${signal.symbol}`,
    signal.candleTime
  );

  await bot.sendMessage(
    chatId,
    signalMessage(signal)
  );
}

// ===============================
// FIND BEST SIGNAL
// ===============================

async function findBestSignal(chatId = null) {
  const found = [];

  for (const pair of PAIRS) {
    try {
      const candles = await getCandles(pair);

      const signal = analyze(
        pair,
        candles
      );

      if (!signal) {
        continue;
      }

      // Prevent the exact same setup/candle
      // from being sent repeatedly.
      if (chatId !== null) {
        const key = `${chatId}_${pair}`;
        const previousCandle =
          lastSignalCandle.get(key);

        if (
          previousCandle &&
          previousCandle === signal.candleTime
        ) {
          continue;
        }
      }

      found.push(signal);

    } catch (error) {
      console.error(
        `❌ ${pair}: ${error.message}`
      );
    }
  }

  if (!found.length) {
    return null;
  }

  // Strongest confidence first
  found.sort(
    (a, b) =>
      b.confidence - a.confidence
  );

  return found[0];
}

// ===============================
// MANUAL SIGNAL
// ===============================

async function sendBestSignal(chatId) {
  if (currentSessionState() !== "ACTIVE") {
    await bot.sendMessage(
      chatId,
      `💤 SIGNAL SESSION IS OFF

⏰ The bot is currently in its 8:00 PM – 9:00 PM Nigeria break.

🟢 New signals resume at 9:00 PM.`
    );

    return;
  }

  await bot.sendMessage(
    chatId,
    "🔎 Scanning all configured pairs for the strongest confirmed setup..."
  );

  const signal =
    await findBestSignal(chatId);

  if (!signal) {
    await bot.sendMessage(
      chatId,
      `⏳ NO HIGH-QUALITY SIGNAL

The engine did not find a sufficiently strong confirmed setup.

🔄 It will continue scanning.`
    );

    return;
  }

  await sendSignal(
    chatId,
    signal
  );
}

// ===============================
// AUTOMATIC SCANNER
// ===============================

async function automaticScanner() {
  if (
    currentSessionState() !==
    "ACTIVE"
  ) {
    return;
  }

  for (const chatId of users) {
    // One active signal at a time
    const hasActiveSignal =
      [...activeSignals.values()]
        .some(
          (signal) =>
            signal.chatId === chatId
        );

    if (hasActiveSignal) {
      continue;
    }

    try {
      const signal =
        await findBestSignal(chatId);

      if (!signal) {
        continue;
      }

      await sendSignal(
        chatId,
        signal
      );

      console.log(
        `🚨 SIGNAL ${signal.symbol} ${signal.direction} ${signal.confidence}% → ${chatId}`
      );

    } catch (error) {
      console.error(
        "❌ Scanner error:",
        error.message
      );
    }
  }
}

// ===============================
// CHECK 1M RESULTS
// ===============================

async function checkResults() {
  const now = Date.now();

  for (const [id, signal] of activeSignals) {
    if (now < signal.expiryAt) {
      continue;
    }

    try {
      const candles =
        await getCandles(
          signal.symbol
        );

      const last =
        candles[candles.length - 1];

      const entry = signal.entry;
      const finalPrice =
        last.close;

      let win = false;

      if (
        signal.direction ===
        "BUY"
      ) {
        win =
          finalPrice > entry;
      }

      if (
        signal.direction ===
        "SELL"
      ) {
        win =
          finalPrice < entry;
      }

      // ===========================
      // UPDATE STATS
      // ===========================

      dailyStats.trades++;

      if (
        !dailyStats.pairs[
          signal.symbol
        ]
      ) {
        dailyStats.pairs[
          signal.symbol
        ] = {
          wins: 0,
          losses: 0
        };
      }

      // ===========================
      // WIN
      // ===========================

      if (win) {
        dailyStats.wins++;

        dailyStats.pairs[
          signal.symbol
        ].wins++;

        await bot.sendMessage(
          signal.chatId,
          `🏆 RESULT: WIN 🟢

💱 ${signal.symbol}

📈 Direction: ${signal.direction}

⌛ Expiry: 1M

💰 Entry: ${entry}

💰 Result: ${finalPrice}

🏆 WIN

🔄 Scanning all pairs again for the next confirmed setup...`
        );
      }

      // ===========================
      // LOSS
      // ===========================

      else {
        dailyStats.losses++;

        dailyStats.pairs[
          signal.symbol
        ].losses++;

        await bot.sendMessage(
          signal.chatId,
          `❌ RESULT: LOSS 🔴

💱 ${signal.symbol}

📉 Direction: ${signal.direction}

⌛ Expiry: 1M

💰 Entry: ${entry}

💰 Result: ${finalPrice}

❌ LOSS

🔄 Scanning all pairs again for the next confirmed setup...`
        );
      }

      activeSignals.delete(id);

    } catch (error) {
      console.error(
        "❌ Result error:",
        error.message
      );

      activeSignals.delete(id);
    }
  }
}

// ===============================
// DAILY REPORT
// ===============================

async function sendDailyReport(chatId) {
  const total =
    dailyStats.trades;

  const winRate =
    total === 0
      ? "0.00"
      : (
          (dailyStats.wins /
            total) *
          100
        ).toFixed(2);

  const pairLines =
    Object.entries(
      dailyStats.pairs
    )
      .map(
        ([pair, stats]) =>
          `💱 ${pair}: ${stats.wins}W / ${stats.losses}L`
      )
      .join("\n") ||
    "No completed trades.";

  await bot.sendMessage(
    chatId,
    `📊 DAILY SIGNAL REPORT

📅 Date: ${nigeriaDate()}

━━━━━━━━━━━━━━

🏁 Total Trades: ${total}

🏆 Wins: ${dailyStats.wins}

❌ Losses: ${dailyStats.losses}

📈 Win Rate: ${winRate}%

━━━━━━━━━━━━━━

💱 PAIR PERFORMANCE

${pairLines}

━━━━━━━━━━━━━━

💵 Risk Setting:
${RISK_PERCENT}% of Capital

⚠️ Monetary P/L is not calculated because the bot does not have access to your Pocket Option account balance or actual payout.

🔴 Trading session closed.

⏰ Next session:
9:00 PM Nigeria time.`
  );
}

// ===============================
// DAILY SCHEDULE
// ===============================

async function dailySchedule() {
  const t =
    nigeriaTimeParts();

  const today =
    nigeriaDate();

  // Exactly 8:00 PM
  if (
    t.hour === 20 &&
    t.minute === 0 &&
    lastReportDate !== today
  ) {
    lastReportDate = today;

    // Stop active signals
    activeSignals.clear();

    for (const chatId of users) {
      try {
        await sendDailyReport(
          chatId
        );
      } catch (error) {
        console.error(
          "❌ Report error:",
          error.message
        );
      }
    }

    resetDailyStats();

    console.log(
      "📊 Daily report sent. Trading session closed."
    );
  }
}

// ===============================
// START LOOPS
// ===============================

setInterval(
  automaticScanner,
  SCAN_INTERVAL
);

setInterval(
  checkResults,
  RESULT_CHECK_INTERVAL
);

setInterval(
  dailySchedule,
  1000
);

// ===============================
// START MESSAGE
// ===============================

console.log(
  "🚀 BINARY SIGNAL PRO STARTED"
);

console.log(
  "📊 Analysis:",
  ANALYSIS_TIMEFRAME
);

console.log(
  "⌛ Expiry:",
  `${EXPIRY_MINUTES}M`
);

console.log(
  "💱 Pairs:",
  PAIRS.length
);

console.log(
  "🔄 Continuous scanning: ON"
);

console.log(
  "🌐 Public users: ENABLED"
);

console.log(
  "🚫 Custom menu buttons: REMOVED"
);
