const TelegramBot = require("node-telegram-bot-api");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

const TIMEZONE = "Africa/Lagos";

// =====================================================
// SETTINGS
// =====================================================

const ANALYSIS_TIMEFRAME = "1min";

// 1-minute binary expiry
const EXPIRY_MINUTES = 1;

// Scan every 60 seconds
const SCAN_INTERVAL = 60 * 1000;

// Check finished signals every 10 seconds
const RESULT_CHECK_INTERVAL = 10 * 1000;

// Minimum strategy score
const MIN_CONFIDENCE = 76;

// Requested risk display
const RISK_PERCENT = 5;

/*
 * IMPORTANT - API RATE LIMITS:
 *
 * The previous version fetched candles separately for
 * every PAIR, for every USER, on every scan. With 10
 * pairs and even a handful of users that is hundreds of
 * API calls per minute - far beyond Twelve Data's free
 * tier (both the daily credit cap AND the per-minute
 * request cap).
 *
 * Fix: there is now ONE shared scan per cycle. All pairs
 * are fetched once, sequentially, with a small delay
 * between each call, and the results (candleCache +
 * signalPool) are shared by every user. Manual /signal
 * requests reuse the same cached pool instead of
 * triggering their own fetch, unless the cache is stale.
 *
 * NOTE: Twelve Data's free plan is commonly rate-limited
 * per MINUTE (commonly ~8 requests/min), not just per day.
 * Scanning 10 pairs every 60 seconds is still tight even
 * with this fix. Check your actual plan's per-minute limit
 * on the Twelve Data dashboard and adjust FETCH_DELAY_MS
 * or trim PAIRS if you see 429 / "too many requests" in
 * the logs.
 */
const FETCH_DELAY_MS = 6500;

// =====================================================
// PAIRS
// =====================================================

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

// =====================================================
// CHECK ENVIRONMENT
// =====================================================

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN is missing");
  process.exit(1);
}

if (!TWELVE_DATA_API_KEY) {
  console.error("❌ TWELVE_DATA_API_KEY is missing");
  process.exit(1);
}

// =====================================================
// TELEGRAM BOT
// =====================================================

const bot = new TelegramBot(BOT_TOKEN, {
  polling: true
});

// Anyone who sends /start is registered
const users = new Set();

// Active signals
const activeSignals = new Map();

// Prevent sending the same setup repeatedly
const lastSignalCandle = new Map();

// =====================================================
// SHARED CANDLE CACHE + SIGNAL POOL
// =====================================================

// symbol -> { candles, lastUpdated }
const candleCache = new Map();

// Shared result of the latest full scan, strongest first.
let signalPool = [];
let signalPoolUpdatedAt = 0;

let apiQuotaBlockedUntil = 0;
let apiQuotaMessage = "";
let lastApiQuotaLog = 0;

let refreshing = false;
let checkingResults = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =====================================================
// DAILY STATISTICS
// =====================================================

const dailyStats = {
  trades: 0,
  wins: 0,
  losses: 0,
  profit: 0,
  loss: 0,
  pairs: {}
};

let lastReportDate = null;

// =====================================================
// WEB SERVER
// =====================================================

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
    activeSignals: activeSignals.size,
    signalPoolSize: signalPool.length,
    signalPoolAgeMs: signalPoolUpdatedAt
      ? Date.now() - signalPoolUpdatedAt
      : null,
    apiQuotaBlocked: Date.now() < apiQuotaBlockedUntil,
    apiQuotaBlockedUntil: apiQuotaBlockedUntil
      ? new Date(apiQuotaBlockedUntil).toISOString()
      : null,
    apiQuotaMessage: apiQuotaMessage || null
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// =====================================================
// NIGERIA TIME
// =====================================================

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

function formatNigeriaTime() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  }).format(new Date());
}

// =====================================================
// TRADING SESSION
// =====================================================
//
// ACTIVE:
// 9:00 PM → 8:00 PM
//
// BREAK:
// 8:00 PM → 9:00 PM
// =====================================================

function currentSessionState() {
  const t = nigeriaTimeParts();

  const minutes = t.hour * 60 + t.minute;

  if (minutes >= 21 * 60 || minutes < 20 * 60) {
    return "ACTIVE";
  }

  return "BREAK";
}

// =====================================================
// RESET DAILY STATS
// =====================================================

function resetDailyStats() {
  dailyStats.trades = 0;
  dailyStats.wins = 0;
  dailyStats.losses = 0;
  dailyStats.profit = 0;
  dailyStats.loss = 0;
  dailyStats.pairs = {};

  lastSignalCandle.clear();
}

// =====================================================
// /START
// =====================================================
//
// NO MENU BUTTONS
// PUBLIC BOT
// =====================================================

bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;

  users.add(chatId);

  console.log(`👤 User registered: ${chatId}`);

  const session = currentSessionState();

  let message = `
🚨 BINARY SIGNAL PRO 🚨

Welcome to the signal engine.

🧠 SMC ANALYSIS
📊 1M TIMEFRAME
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

After every completed trade,
the engine scans again.
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

// =====================================================
// MANUAL /SIGNAL
// =====================================================

bot.onText(/^\/signal$/, async (msg) => {
  const chatId = msg.chat.id;

  users.add(chatId);

  await sendBestSignal(chatId);
});

// =====================================================
// /MARKET
// =====================================================

bot.onText(/^\/market$/, async (msg) => {
  const chatId = msg.chat.id;

  users.add(chatId);

  const session = currentSessionState();

  const apiStatus =
    Date.now() < apiQuotaBlockedUntil
      ? `⏸️ Paused until ${new Date(
          apiQuotaBlockedUntil
        ).toLocaleTimeString("en-US", { timeZone: TIMEZONE })}`
      : "✅ Active";

  const poolAge = signalPoolUpdatedAt
    ? `${Math.round((Date.now() - signalPoolUpdatedAt) / 1000)}s ago`
    : "not scanned yet";

  await bot.sendMessage(
    chatId,
    `📊 MARKET STATUS

🕐 Nigeria Time:
${formatNigeriaTime()}

📡 Session:
${session === "ACTIVE" ? "🟢 ACTIVE" : "💤 BREAK"}

📊 Analysis:
${ANALYSIS_TIMEFRAME.toUpperCase()}

⌛ Expiry:
${EXPIRY_MINUTES}M

💱 Configured Pairs:
${PAIRS.length}

🔄 Continuous Scanning:
ON

🛰 Data Engine:
${apiStatus}

🕓 Last full scan:
${poolAge}`
  );
});

// =====================================================
// /RESULTS
// =====================================================

bot.onText(/^\/results$/, async (msg) => {
  const chatId = msg.chat.id;

  users.add(chatId);

  const total = dailyStats.trades;

  const winRate =
    total === 0
      ? "0.00"
      : ((dailyStats.wins / total) * 100).toFixed(2);

  await bot.sendMessage(
    chatId,
    `📊 TODAY'S RESULTS

🏁 Trades:
${total}

🏆 Wins:
${dailyStats.wins}

❌ Losses:
${dailyStats.losses}

📈 Win Rate:
${winRate}%

💵 Risk Setting:
${RISK_PERCENT}% of Capital

⚠️ Monetary profit/loss is not calculated because the bot does not have access to your Pocket Option balance or payout.`
  );
});

// =====================================================
// /PAIRS
// =====================================================

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

// =====================================================
// /HELP
// =====================================================

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

📊 Analysis: 1M
⌛ Expiry: 1M

🔄 Automatic scanning remains ON while the trading session is active.`
  );
});

// =====================================================
// API ERROR HANDLING (shared quota circuit breaker)
// =====================================================

function nextUtcMidnight() {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

function isQuotaError(message, status) {
  const m = String(message || "").toLowerCase();

  return (
    status === 429 ||
    m.includes("run out of api credits") ||
    m.includes("api credits") ||
    m.includes("too many requests")
  );
}

function handleApiError(label, message, status) {
  if (isQuotaError(message, status)) {
    if (/daily|800|day/i.test(String(message))) {
      apiQuotaBlockedUntil = nextUtcMidnight();
    } else {
      // Likely a per-minute limit - back off briefly, not all day.
      apiQuotaBlockedUntil = Date.now() + 65 * 1000;
    }

    apiQuotaMessage = String(message);

    if (Date.now() - lastApiQuotaLog > 30000) {
      console.error(
        `${label}: Twelve Data quota/rate limit: ${message}`
      );
      console.error(
        `API calls paused until ${new Date(
          apiQuotaBlockedUntil
        ).toISOString()}`
      );
      lastApiQuotaLog = Date.now();
    }

    return true;
  }

  console.error(`❌ ${label}: ${message}`);
  return false;
}

// =====================================================
// TWELVE DATA CANDLES
// =====================================================

async function getCandles(symbol) {
  const url =
    "https://api.twelvedata.com/time_series" +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${ANALYSIS_TIMEFRAME}` +
    `&outputsize=80` +
    `&timezone=UTC` +
    `&apikey=${TWELVE_DATA_API_KEY}`;

  const response = await fetch(url);

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(
      data?.message || `HTTP ${response.status}`
    );
    error.status = response.status;
    throw error;
  }

  if (data?.status === "error") {
    const error = new Error(data.message || "Twelve Data error");
    error.status = data.code;
    throw error;
  }

  if (!Array.isArray(data?.values)) {
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

// =====================================================
// CANDLE HELPERS
// =====================================================

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

  return data.reduce((sum, c) => sum + body(c), 0) / data.length;
}

// =====================================================
// TREND
// =====================================================

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

// =====================================================
// FAIR VALUE GAP
// =====================================================

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

// =====================================================
// ORDER BLOCK
// =====================================================

function detectOrderBlock(candles) {
  if (candles.length < 6) {
    return null;
  }

  const previous = candles[candles.length - 3];
  const impulse = candles[candles.length - 2];

  const avg = averageBody(candles);

  // Bullish Order Block
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

  // Bearish Order Block
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

// =====================================================
// LIQUIDITY
// =====================================================

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

// =====================================================
// CONFIRMATION
// =====================================================

function confirmation(candles) {
  if (candles.length < 5) {
    return "WEAK";
  }

  // Use last completed candle
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

// =====================================================
// SMC ANALYSIS
// =====================================================

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

  // Last candle
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

// =====================================================
// SIGNAL MESSAGE
// =====================================================

function signalMessage(signal) {
  const now = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  }).format(new Date());

  const arrow = signal.direction === "BUY" ? "🟢 BUY" : "🔴 SELL";

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

🔄 CONTINUOUS SCANNING

⚠️ Confidence is a strategy score,
not a guaranteed win probability.`;
}

// =====================================================
// SEND SIGNAL
// =====================================================

async function sendSignal(chatId, signal) {
  const id = `${chatId}_${signal.symbol}_${Date.now()}`;

  activeSignals.set(id, {
    ...signal,
    chatId,
    id,
    expiryAt: Date.now() + EXPIRY_MINUTES * 60 * 1000
  });

  lastSignalCandle.set(`${chatId}_${signal.symbol}`, signal.candleTime);

  await bot.sendMessage(chatId, signalMessage(signal));

  console.log(
    `📡 SENT ${signal.symbol} ${signal.direction} ${signal.confidence}% → ${chatId}`
  );
}

// =====================================================
// SHARED SCAN - fetches every pair ONCE per cycle and
// builds signalPool. Shared by every user.
// =====================================================

async function refreshAllCandles() {
  if (refreshing) {
    return;
  }

  if (Date.now() < apiQuotaBlockedUntil) {
    return;
  }

  refreshing = true;

  const found = [];

  try {
    for (const pair of PAIRS) {
      if (Date.now() < apiQuotaBlockedUntil) {
        // Quota/rate-limit hit mid-scan - stop hammering
        // the remaining pairs this cycle.
        break;
      }

      try {
        const candles = await getCandles(pair);

        candleCache.set(pair, {
          candles,
          lastUpdated: Date.now()
        });

        const signal = analyze(pair, candles);

        if (signal) {
          found.push(signal);
        }
      } catch (error) {
        handleApiError(`getCandles(${pair})`, error.message, error.status);
      }

      await sleep(FETCH_DELAY_MS);
    }

    found.sort((a, b) => b.confidence - a.confidence);

    signalPool = found;
    signalPoolUpdatedAt = Date.now();
  } finally {
    refreshing = false;
  }
}

async function refreshAllCandlesIfDue() {
  const stale =
    !signalPoolUpdatedAt ||
    Date.now() - signalPoolUpdatedAt >= SCAN_INTERVAL;

  if (!stale) {
    return;
  }

  await refreshAllCandles();
}

// =====================================================
// PICK A SIGNAL FROM THE SHARED POOL FOR ONE USER
// (skips setups already sent to that user on this candle)
// =====================================================

function pickSignalForUser(chatId) {
  return signalPool.find((signal) => {
    const key = `${chatId}_${signal.symbol}`;
    const previousCandle = lastSignalCandle.get(key);

    return !(previousCandle && previousCandle === signal.candleTime);
  });
}

// =====================================================
// MANUAL SIGNAL
// =====================================================

async function sendBestSignal(chatId) {
  if (currentSessionState() !== "ACTIVE") {
    await bot.sendMessage(
      chatId,
      `💤 SIGNAL SESSION IS OFF

⏰ The bot is currently in the 8:00 PM – 9:00 PM Nigeria break.

🟢 New signals resume at 9:00 PM.`
    );

    return;
  }

  await bot.sendMessage(
    chatId,
    "🔎 Scanning all configured pairs for the strongest confirmed 1M setup..."
  );

  // Reuses the shared pool if it's still fresh - does NOT
  // trigger a new fetch per user.
  await refreshAllCandlesIfDue();

  if (Date.now() < apiQuotaBlockedUntil) {
    await bot.sendMessage(
      chatId,
      `⚠️ DATA ENGINE TEMPORARILY LIMITED

The market data provider is rate-limiting requests right now.

🔄 It will resume automatically - please try again shortly.`
    );

    return;
  }

  const candidate = pickSignalForUser(chatId);

  if (!candidate) {
    await bot.sendMessage(
      chatId,
      `⏳ NO HIGH-QUALITY SIGNAL

The engine did not find a sufficiently strong confirmed setup.

🔄 It will continue scanning.`
    );

    return;
  }

  await sendSignal(chatId, candidate);
}

// =====================================================
// AUTOMATIC SCANNER
// =====================================================

async function automaticScanner() {
  if (currentSessionState() !== "ACTIVE") {
    return;
  }

  await refreshAllCandlesIfDue();

  if (!signalPool.length) {
    return;
  }

  for (const chatId of users) {
    // Only one active signal per user
    const hasActiveSignal = [...activeSignals.values()].some(
      (signal) => signal.chatId === chatId
    );

    if (hasActiveSignal) {
      continue;
    }

    const candidate = pickSignalForUser(chatId);

    if (!candidate) {
      continue;
    }

    try {
      await sendSignal(chatId, candidate);

      console.log(
        `🚨 SIGNAL ${candidate.symbol} ${candidate.direction} ${candidate.confidence}%`
      );
    } catch (error) {
      console.error("❌ Scanner error:", error.message);
    }
  }
}

// =====================================================
// CHECK RESULTS
//
// Fetches fresh candles only for symbols that actually
// have a due signal (bounded by active signals, not by
// PAIRS x users), grouped so each symbol is fetched once
// per cycle even if several users hold a signal on it.
// =====================================================

async function checkResults() {
  if (checkingResults) {
    return;
  }

  checkingResults = true;

  try {
    const now = Date.now();

    const dueEntries = [...activeSignals.entries()].filter(
      ([, signal]) => now >= signal.expiryAt
    );

    if (!dueEntries.length) {
      return;
    }

    if (Date.now() < apiQuotaBlockedUntil) {
      // Leave due signals pending - they'll be evaluated
      // on the next cycle once the quota/rate-limit clears.
      return;
    }

    const symbolsNeeded = [
      ...new Set(dueEntries.map(([, signal]) => signal.symbol))
    ];

    const freshCandles = new Map();

    for (const symbol of symbolsNeeded) {
      if (Date.now() < apiQuotaBlockedUntil) {
        break;
      }

      try {
        const candles = await getCandles(symbol);

        candleCache.set(symbol, {
          candles,
          lastUpdated: Date.now()
        });

        freshCandles.set(symbol, candles);
      } catch (error) {
        handleApiError(
          `checkResults(${symbol})`,
          error.message,
          error.status
        );
      }

      await sleep(FETCH_DELAY_MS);
    }

    for (const [id, signal] of dueEntries) {
      const candles = freshCandles.get(signal.symbol);

      if (!candles) {
        // Couldn't fetch this symbol this cycle - leave the
        // signal in place and retry on the next cycle rather
        // than silently discarding the trade result.
        continue;
      }

      const last = candles[candles.length - 1];

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
          `🏆 RESULT: WIN 🟢

💱 ${signal.symbol}

📈 Direction:
${signal.direction}

⌛ Expiry:
1M

💰 Entry:
${entry}

💰 Result:
${finalPrice}

🏆 WIN

🔄 Scanning all pairs again for the next confirmed setup...`
        );
      } else {
        dailyStats.losses++;
        dailyStats.pairs[signal.symbol].losses++;

        await bot.sendMessage(
          signal.chatId,
          `❌ RESULT: LOSS 🔴

💱 ${signal.symbol}

📉 Direction:
${signal.direction}

⌛ Expiry:
1M

💰 Entry:
${entry}

💰 Result:
${finalPrice}

❌ LOSS

🔄 Scanning all pairs again for the next confirmed setup...`
        );
      }

      activeSignals.delete(id);
    }
  } finally {
    checkingResults = false;
  }
}

// =====================================================
// DAILY REPORT
// =====================================================

async function sendDailyReport(chatId) {
  const total = dailyStats.trades;

  const winRate =
    total === 0
      ? "0.00"
      : ((dailyStats.wins / total) * 100).toFixed(2);

  const pairLines =
    Object.entries(dailyStats.pairs)
      .map(
        ([pair, stats]) =>
          `💱 ${pair}: ${stats.wins}W / ${stats.losses}L`
      )
      .join("\n") || "No completed trades.";

  await bot.sendMessage(
    chatId,
    `📊 DAILY SIGNAL REPORT

📅 Date:
${nigeriaDate()}

━━━━━━━━━━━━━━

🏁 Total Trades:
${total}

🏆 Wins:
${dailyStats.wins}

❌ Losses:
${dailyStats.losses}

📈 Win Rate:
${winRate}%

━━━━━━━━━━━━━━

💱 PAIR PERFORMANCE

${pairLines}

━━━━━━━━━━━━━━

📊 Analysis:
1M

⌛ Expiry:
1M

💵 Risk Setting:
${RISK_PERCENT}% of Capital

⚠️ Monetary P/L is not calculated because the bot does not have access to your Pocket Option account balance or actual payout.

🔴 Trading session closed.

⏰ Next session:
9:00 PM Nigeria time.`
  );
}

// =====================================================
// DAILY SCHEDULE
// =====================================================

async function dailySchedule() {
  const t = nigeriaTimeParts();

  const today = nigeriaDate();

  // 8:00 PM Nigeria time
  if (t.hour === 20 && t.minute === 0 && lastReportDate !== today) {
    lastReportDate = today;

    // Stop active signals
    activeSignals.clear();

    for (const chatId of users) {
      try {
        await sendDailyReport(chatId);
      } catch (error) {
        console.error("❌ Report error:", error.message);
      }
    }

    resetDailyStats();

    console.log("📊 Daily report sent. Trading session closed.");
  }
}

// =====================================================
// START AUTOMATIC LOOPS
// =====================================================

setInterval(automaticScanner, SCAN_INTERVAL);

setInterval(checkResults, RESULT_CHECK_INTERVAL);

setInterval(dailySchedule, 1000);

// =====================================================
// STARTUP LOG
// =====================================================

console.log("🚀 BINARY SIGNAL PRO STARTED");
console.log("📊 Analysis timeframe: 1min");
console.log("⌛ Expiry: 1M");
console.log("🔄 Scan interval: 60 seconds");
console.log("💱 Pairs:", PAIRS.length);
console.log("🧠 SMC confirmation: ON");
console.log("🌐 Public users: ENABLED");
console.log("🚫 Custom menu buttons: REMOVED");
console.log("🔄 Continuous scanning: ON");
console.log(
  `🛰 Shared scan: 1 fetch/pair/cycle, ${FETCH_DELAY_MS}ms spacing`
);
