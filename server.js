// ================================================================
// 🚨 BINARY SIGNAL PRO
// Telegram + Twelve Data
// 5M analysis / 1M expiry
// SIGNAL ONLY — NO AUTOMATIC POCKET OPTION TRADING
// ================================================================

const TelegramBot = require("node-telegram-bot-api");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

const TIMEZONE = "Africa/Lagos";

// ================================================================
// SETTINGS
// ================================================================

const ANALYSIS_TIMEFRAME = "5min";
const EXPIRY_MINUTES = 1;

const SCAN_INTERVAL = 15 * 1000;
const RESULT_CHECK_INTERVAL = 10 * 1000;

const MIN_CONFIDENCE = 76;
const RISK_PERCENT = 5;

// ================================================================
// PAIRS
// ================================================================

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

// ================================================================
// STARTUP CHECK
// ================================================================

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

// ================================================================
// MEMORY
// ================================================================

const users = new Set();

const activeSignals = new Map();

const dailyStats = {
  trades: 0,
  wins: 0,
  losses: 0,
  profit: 0,
  loss: 0,
  pairs: {}
};

let currentTradingDay = null;

// ================================================================
// EXPRESS
// ================================================================

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
    activeSignals: activeSignals.size
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// ================================================================
// NIGERIA TIME
// ================================================================

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

function currentSessionState() {
  const t = nigeriaTimeParts();

  const minutes = t.hour * 60 + t.minute;

  // Active from 9:00 PM until 8:00 PM next day.
  if (minutes >= 21 * 60 || minutes < 20 * 60) {
    return "ACTIVE";
  }

  // 8:00 PM - 8:59:59 PM break/report period.
  return "BREAK";
}

// ================================================================
// RESET DAILY STATISTICS
// ================================================================

function resetDailyStats() {
  dailyStats.trades = 0;
  dailyStats.wins = 0;
  dailyStats.losses = 0;
  dailyStats.profit = 0;
  dailyStats.loss = 0;
  dailyStats.pairs = {};
}

// ================================================================
// USER MENU
// ================================================================

function mainMenu() {
  return {
    reply_markup: {
      keyboard: [
        ["📡 SIGNAL", "📊 MARKET"],
        ["📈 RESULTS", "💱 PAIRS"],
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
╔══════════════════════════╗
     🚨 BINARY SIGNAL PRO
╚══════════════════════════╝

👋 Welcome!

⏱ Analysis: 5M
⌛ Expiry: 1M

🧠 FVG
📦 Order Block
📈 Trend
💧 Liquidity
🕯️ Confirmation

━━━━━━━━━━━━━━━━━━━━

🟢 CALL
🔴 PUT

💵 Risk setting: ${RISK_PERCENT}%

━━━━━━━━━━━━━━━━━━━━

🕘 SESSION
9:00 PM → 8:00 PM

💤 BREAK
8:00 PM → 9:00 PM

📊 Daily report: 8:00 PM

⚠️ SIGNALS ONLY
`,
    mainMenu()
  );
});

// ================================================================
// BUTTONS
// ================================================================

bot.on("message", async (msg) => {
  if (!msg.text) return;

  const chatId = msg.chat.id;
  const text = msg.text;

  users.add(chatId);

  if (text === "📡 SIGNAL") {
    await sendBestSignal(chatId);
    return;
  }

  if (text === "📊 MARKET") {
    await showMarket(chatId);
    return;
  }

  if (text === "📈 RESULTS") {
    await sendDailyReport(chatId);
    return;
  }

  if (text === "💱 PAIRS") {
    await bot.sendMessage(
      chatId,
      `
💱 MONITORED PAIRS

${PAIRS.map((p, i) => `${i + 1}️⃣ ${p}`).join("\n")}

⏱ Analysis: 5M
⌛ Expiry: 1M
`
    );
    return;
  }

  if (text === "ℹ️ HOW IT WORKS") {
    await bot.sendMessage(
      chatId,
      `
🧠 SIGNAL ENGINE

The bot scans the configured pairs.

It checks:

📈 Trend
💎 Fair Value Gap
📦 Order Block
💧 Liquidity
🕯️ Confirmation

Only a sufficiently strong setup
can become a signal.

After the 1M expiry:

🏆 WIN
or
❌ LOSS

Then the engine scans again.

🔄 CONTINUOUS SCANNING

⚠️ Signals are not guaranteed profits.
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
// CANDLE HELPERS
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

function averageBody(candles, count = 10) {
  const data = candles.slice(-count);

  if (!data.length) return 0;

  return (
    data.reduce((sum, c) => sum + body(c), 0) /
    data.length
  );
}

// ================================================================
// TREND
// ================================================================

function getTrend(candles) {
  const recent = candles.slice(-15);

  let up = 0;
  let down = 0;

  for (let i = 1; i < recent.length; i++) {
    if (recent[i].close > recent[i - 1].close) up++;
    if (recent[i].close < recent[i - 1].close) down++;
  }

  if (up >= down + 4) return "BULLISH";
  if (down >= up + 4) return "BEARISH";

  return "NEUTRAL";
}

// ================================================================
// FVG
// ================================================================

function detectFVG(candles) {
  if (candles.length < 5) return null;

  const a = candles[candles.length - 4];
  const c = candles[candles.length - 2];

  if (c.low > a.high) {
    return {
      type: "BULLISH",
      low: a.high,
      high: c.low
    };
  }

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

  const avg = averageBody(candles);

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

// ================================================================
// LIQUIDITY
// ================================================================

function liquidityDirection(candles) {
  const recent = candles.slice(-8);

  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);

  const last = recent[recent.length - 1];

  const previousHigh = Math.max(...highs.slice(0, -1));
  const previousLow = Math.min(...lows.slice(0, -1));

  if (last.close > previousHigh) return "BULLISH";
  if (last.close < previousLow) return "BEARISH";

  return "NONE";
}

// ================================================================
// CONFIRMATION
// ================================================================

function confirmation(candles) {
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

// ================================================================
// SIGNAL ENGINE
// ================================================================

function analyze(symbol, candles) {
  if (candles.length < 20) return null;

  const trend = getTrend(candles);
  const fvg = detectFVG(candles);
  const ob = detectOrderBlock(candles);
  const liquidity = liquidityDirection(candles);
  const confirm = confirmation(candles);

  let buy = 0;
  let sell = 0;

  if (trend === "BULLISH") buy += 2;
  if (trend === "BEARISH") sell += 2;

  if (fvg?.type === "BULLISH") buy += 2;
  if (fvg?.type === "BEARISH") sell += 2;

  if (ob?.type === "BULLISH") buy += 2;
  if (ob?.type === "BEARISH") sell += 2;

  if (liquidity === "BULLISH") buy += 1;
  if (liquidity === "BEARISH") sell += 1;

  if (confirm === "BULLISH") buy += 2;
  if (confirm === "BEARISH") sell += 2;

  const score = Math.max(buy, sell);

  if (score < 7) return null;

  let direction;

  if (buy > sell) direction = "BUY";
  else if (sell > buy) direction = "SELL";
  else return null;

  const confidence = Math.min(
    95,
    55 + score * 5
  );

  if (confidence < MIN_CONFIDENCE) return null;

  return {
    symbol,
    direction,
    confidence,
    trend,
    fvg: fvg?.type || "NONE",
    orderBlock: ob?.type || "NONE",
    liquidity,
    confirmation: confirm,
    entry: candles[candles.length - 1].close,
    createdAt: Date.now()
  };
}

// ================================================================
// SIGNAL MESSAGE
// ================================================================

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

  return `
🚨 BINARY SIGNAL 🚨

⏱ Trade Time: ${now}

💱 ${signal.symbol} → ${arrow}

⌛ Expiry: 1M

📊 Confidence: ${signal.confidence}%

📈 SIGNAL RULES

💵 Risk: ${RISK_PERCENT}% of Capital
`;
}

// ================================================================
// SEND SIGNAL
// ================================================================

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

  await bot.sendMessage(
    chatId,
    signalMessage(signal)
  );
}

// ================================================================
// FIND BEST SIGNAL
// ================================================================

async function findBestSignal() {
  const found = [];

  for (const pair of PAIRS) {
    try {
      const candles = await getCandles(pair);
      const signal = analyze(pair, candles);

      if (signal) {
        found.push(signal);
      }
    } catch (error) {
      console.error(
        `❌ ${pair}: ${error.message}`
      );
    }
  }

  if (!found.length) return null;

  found.sort(
    (a, b) => b.confidence - a.confidence
  );

  return found[0];
}

// ================================================================
// MANUAL SIGNAL
// ================================================================

async function sendBestSignal(chatId) {
  if (currentSessionState() !== "ACTIVE") {
    await bot.sendMessage(
      chatId,
      `
💤 SIGNAL SESSION IS OFF

⏰ Current session is on break.

🚀 Next session:
9:00 PM WAT
`
    );

    return;
  }

  await bot.sendMessage(
    chatId,
    "🔎 Scanning all pairs for confirmation..."
  );

  const signal = await findBestSignal();

  if (!signal) {
    await bot.sendMessage(
      chatId,
      `
⏳ NO HIGH-QUALITY SIGNAL

🔎 All configured pairs checked.

🛡️ No confirmed setup found.

Wait for the next market opportunity.
`
    );

    return;
  }

  await sendSignal(chatId, signal);
}

// ================================================================
// AUTOMATIC SIGNAL ENGINE
// ================================================================

async function automaticScanner() {
  if (currentSessionState() !== "ACTIVE") {
    return;
  }

  // Only one unresolved signal at a time per user.
  for (const chatId of users) {
    const hasActive = [...activeSignals.values()]
      .some(s => s.chatId === chatId);

    if (hasActive) continue;

    try {
      const signal = await findBestSignal();

      if (!signal) continue;

      await sendSignal(chatId, signal);

      console.log(
        `🚨 SIGNAL ${signal.symbol} ${signal.direction} ${signal.confidence}%`
      );

    } catch (error) {
      console.error(
        "Scanner error:",
        error.message
      );
    }
  }
}

// ================================================================
// RESULT CHECKER
// ================================================================

async function checkResults() {
  const now = Date.now();

  for (const [id, signal] of activeSignals) {
    if (now < signal.expiryAt) continue;

    try {
      const candles =
        await getCandles(signal.symbol);

      const last =
        candles[candles.length - 1];

      const entry = signal.entry;
      const finalPrice = last.close;

      let win = false;

      if (signal.direction === "BUY") {
        win = finalPrice > entry;
      }

      if (signal.direction === "SELL") {
        win = finalPrice < entry;
      }

      dailyStats.trades++;

      if (!dailyStats.pairs[signal.symbol]) {
        dailyStats.pairs[signal.symbol] = {
          wins: 0,
          losses: 0
        };
      }

      if (win) {
        dailyStats.wins++;
        dailyStats.pairs[signal.symbol].wins++;

        await bot.sendMessage(
          signal.chatId,
          `
🏆 RESULT

💱 ${signal.symbol}
${signal.direction === "BUY" ? "🟢 BUY" : "🔴 SELL"}

✅ WIN

━━━━━━━━━━━━━━━━━━━━
📊 Confidence: ${signal.confidence}%
⌛ Expiry: 1M
━━━━━━━━━━━━━━━━━━━━

🔎 Scanning for the next setup...
`
        );
      } else {
        dailyStats.losses++;
        dailyStats.pairs[signal.symbol].losses++;

        await bot.sendMessage(
          signal.chatId,
          `
❌ RESULT

💱 ${signal.symbol}
${signal.direction === "BUY" ? "🟢 BUY" : "🔴 SELL"}

🔴 LOSS

━━━━━━━━━━━━━━━━━━━━
📊 Confidence: ${signal.confidence}%
⌛ Expiry: 1M
━━━━━━━━━━━━━━━━━━━━

🔎 Scanning for the next setup...
`
        );
      }

      activeSignals.delete(id);

    } catch (error) {
      console.error(
        "Result error:",
        error.message
      );

      // Don't silently call an unresolved trade a WIN/LOSS.
      activeSignals.delete(id);
    }
  }
}

// ================================================================
// DAILY REPORT
// ================================================================

async function sendDailyReport(chatId) {
  const total = dailyStats.trades;

  const winRate =
    total === 0
      ? 0
      : ((dailyStats.wins / total) * 100).toFixed(2);

  const pairLines =
    Object.entries(dailyStats.pairs)
      .map(([pair, s]) =>
        `💱 ${pair}: ${s.wins}W / ${s.losses}L`
      )
      .join("\n") || "No completed trades.";

  const date = nigeriaDate();

  await bot.sendMessage(
    chatId,
    `
╔══════════════════════════╗
       📊 DAILY RESULTS
╚══════════════════════════╝

📅 ${date}
⏰ 8:00 PM WAT

━━━━━━━━━━━━━━━━━━━━

📌 ALL TRADES
${dailyStats.trades}

🏆 WINS
${dailyStats.wins}

❌ LOSSES
${dailyStats.losses}

📈 WIN RATE
${winRate}%

━━━━━━━━━━━━━━━━━━━━

💱 PAIR BREAKDOWN

${pairLines}

━━━━━━━━━━━━━━━━━━━━

💵 RISK SETTING
${RISK_PERCENT}% of Capital

⚠️ P/L is not calculated as
broker payout here because
payout rates differ by broker
and asset.

━━━━━━━━━━━━━━━━━━━━

💤 SESSION CLOSED

🚀 NEXT SESSION
9:00 PM WAT

━━━━━━━━━━━━━━━━━━━━
`
  );
}

// ================================================================
// 8 PM DAILY REPORT
// ================================================================

let lastReportDate = null;

async function dailySchedule() {
  const t = nigeriaTimeParts();
  const today = nigeriaDate();

  // Report once at 8:00 PM
  if (
    t.hour === 20 &&
    t.minute === 0 &&
    lastReportDate !== today
  ) {
    lastReportDate = today;

    for (const chatId of users) {
      try {
        await sendDailyReport(chatId);
      } catch (error) {
        console.error(
          "Report error:",
          error.message
        );
      }
    }

    // Clear active signals.
    activeSignals.clear();

    // Reset after report.
    resetDailyStats();

    console.log(
      "📊 Daily report sent. Session closed."
    );
  }
}

// ================================================================
// SCHEDULE LOOPS
// ================================================================

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

// ================================================================
// START
// ================================================================

console.log(`
🚀 BINARY SIGNAL PRO STARTED

⏱ Analysis: ${ANALYSIS_TIMEFRAME}
⌛ Expiry: ${EXPIRY_MINUTES}M

🕘 ACTIVE:
9:00 PM → 8:00 PM

💤 BREAK:
8:00 PM → 9:00 PM

📊 DAILY REPORT:
8:00 PM WAT

💱 PAIRS:
${PAIRS.join(", ")}

🛡️ SIGNAL ONLY
`);
