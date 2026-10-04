const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const OTCHARTS_API_KEY = process.env.OTCHARTS_API_KEY;

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");
if (!OTCHARTS_API_KEY) throw new Error("Missing OTCHARTS_API_KEY");

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

/* =========================================================
   SETTINGS
========================================================= */

const VENUE = "otc";
const TIMEFRAME_SECONDS = 60;
const EXPIRY_SECONDS = 60;

const MIN_CONFIDENCE = 76;

// Display only — this is NOT a guaranteed win probability.
const RISK_PERCENT = 5;

// Maximum number of OTC currency pairs.
// 0 = use every available OTC currency pair.
const MAX_CURRENCY_PAIRS = 100;

const SCAN_RETRY_MS = 15000;
const RESULT_CHECK_MS = 5000;
const SYMBOL_REFRESH_MS = 10 * 60 * 1000;

const ACTIVE_START_HOUR = 21; // 9 PM WAT
const ACTIVE_END_HOUR = 20;   // 8 PM WAT

/* =========================================================
   DATA
========================================================= */

const users = new Set();

const activeSignals = new Map();

const stats = new Map();

const candles = new Map();

const lastSignalCandle = new Map();

let otcSymbols = [];

let lastSymbolRefresh = 0;

let streamAbortController = null;

const scanningUsers = new Set();

/* =========================================================
   TIME
========================================================= */

function lagosHour() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Lagos",
    hour: "2-digit",
    hour12: false
  }).formatToParts(new Date());

  return Number(parts.find(x => x.type === "hour").value);
}

function isTradingSession() {
  const h = lagosHour();

  // Active from 9 PM through 7:59 PM.
  // Break from 8 PM to 8:59 PM.
  return h >= ACTIVE_START_HOUR || h < ACTIVE_END_HOUR;
}

function formatTime(ts = Date.now()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Lagos",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  }).format(new Date(ts));
}

/* =========================================================
   HTTP
========================================================= */

async function apiGet(path) {
  const response = await fetch(`https://otcharts.com${path}`, {
    headers: {
      Authorization: `Bearer ${OTCHARTS_API_KEY}`,
      Accept: "application/json"
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`OTCharts ${response.status}: ${text}`);
  }

  return JSON.parse(text);
}

/* =========================================================
   POCKET OPTION OTC CURRENCY LIST
========================================================= */

function isCurrencyPair(item) {
  const name = String(item.name || "").trim();

  // Examples:
  // EUR/USD OTC
  // GBP/JPY OTC
  // NGN/USD OTC

  return /^[A-Z]{3}\/[A-Z]{3} OTC$/i.test(name);
}

async function refreshSymbols(force = false) {
  if (
    !force &&
    otcSymbols.length > 0 &&
    Date.now() - lastSymbolRefresh < SYMBOL_REFRESH_MS
  ) {
    return otcSymbols;
  }

  console.log("🔄 Refreshing Pocket Option OTC currency list...");

  const data = await apiGet("/v1/symbols?venue=otc");

  let pairs = (data.symbols || [])
    .filter(isCurrencyPair)
    .filter(x => x.isOtc !== false);

  // Prefer higher payout instruments when the API supplies payout.
  pairs.sort((a, b) => {
    const pa = Number.isFinite(Number(a.payout)) ? Number(a.payout) : -1;
    const pb = Number.isFinite(Number(b.payout)) ? Number(b.payout) : -1;

    return pb - pa;
  });

  if (MAX_CURRENCY_PAIRS > 0) {
    pairs = pairs.slice(0, MAX_CURRENCY_PAIRS);
  }

  otcSymbols = pairs;
  lastSymbolRefresh = Date.now();

  console.log(
    `💱 Pocket Option OTC currency pairs loaded: ${otcSymbols.length}`
  );

  return otcSymbols;
}

/* =========================================================
   CANDLE STORAGE
========================================================= */

function getPairCandles(symbol) {
  if (!candles.has(symbol)) {
    candles.set(symbol, []);
  }

  return candles.get(symbol);
}

function addTick(symbol, price, timestamp) {
  if (!Number.isFinite(price)) return;

  const bucket = Math.floor(timestamp / 60) * 60;

  const list = getPairCandles(symbol);

  let last = list[list.length - 1];

  if (!last || last.time !== bucket) {
    last = {
      time: bucket,
      open: price,
      high: price,
      low: price,
      close: price
    };

    list.push(last);

    while (list.length > 250) {
      list.shift();
    }
  } else {
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    last.close = price;
  }
}

/* =========================================================
   INITIAL HISTORY
========================================================= */

async function loadInitialCandles(symbol) {
  try {
    const data = await apiGet(
      `/v1/candles?venue=${VENUE}&symbol=${encodeURIComponent(
        symbol
      )}&tf=${TIMEFRAME_SECONDS}&limit=120`
    );

    if (!Array.isArray(data.candles)) return;

    const cleaned = data.candles
      .map(c => ({
        time: Number(c.time),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close)
      }))
      .filter(
        c =>
          Number.isFinite(c.time) &&
          Number.isFinite(c.open) &&
          Number.isFinite(c.high) &&
          Number.isFinite(c.low) &&
          Number.isFinite(c.close)
      )
      .sort((a, b) => a.time - b.time);

    candles.set(symbol, cleaned.slice(-200));
  } catch (err) {
    console.log(`⚠️ History failed ${symbol}: ${err.message}`);
  }
}

async function loadHistoryForPairs() {
  const pairs = await refreshSymbols();

  console.log(`📚 Loading history for ${pairs.length} OTC pairs...`);

  // Sequential requests to avoid hammering the API.
  for (const pair of pairs) {
    await loadInitialCandles(pair.symbol);

    await new Promise(resolve => setTimeout(resolve, 150));
  }

  console.log("✅ Initial OTC history loaded");
}

/* =========================================================
   INDICATORS
========================================================= */

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let result = values
    .slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    result =
      (values[i] - result) * multiplier + result;
  }

  return result;
}

function averageRange(list, period = 14) {
  if (list.length < period + 1) return null;

  const ranges = list
    .slice(-period)
    .map(c => c.high - c.low);

  return ranges.reduce((a, b) => a + b, 0) / ranges.length;
}

/* =========================================================
   SMC ANALYSIS
========================================================= */

function analyzePair(pair) {
  const symbol = pair.symbol;

  const list = getPairCandles(symbol);

  if (list.length < 40) return null;

  // Ignore the currently forming candle.
  const completed = list.slice(0, -1);

  if (completed.length < 35) return null;

  const a = completed[completed.length - 1];
  const b = completed[completed.length - 2];
  const c = completed[completed.length - 3];
  const d = completed[completed.length - 4];

  const closes = completed.map(x => x.close);

  const fastEMA = ema(closes, 9);
  const slowEMA = ema(closes, 21);

  if (fastEMA === null || slowEMA === null) {
    return null;
  }

  const range = averageRange(completed, 14);

  if (!range || range <= 0) return null;

  let buyScore = 0;
  let sellScore = 0;

  const buyReasons = [];
  const sellReasons = [];

  /* TREND */

  if (fastEMA > slowEMA) {
    buyScore += 18;
    buyReasons.push("Bullish trend");
  }

  if (fastEMA < slowEMA) {
    sellScore += 18;
    sellReasons.push("Bearish trend");
  }

  /* MOMENTUM */

  if (a.close > b.high) {
    buyScore += 18;
    buyReasons.push("Bullish BOS");
  }

  if (a.close < b.low) {
    sellScore += 18;
    sellReasons.push("Bearish BOS");
  }

  /* FVG */

  // Bullish FVG:
  // current low > candle two bars back high

  if (a.low > c.high) {
    buyScore += 15;
    buyReasons.push("Bullish FVG");
  }

  // Bearish FVG:
  // current high < candle two bars back low

  if (a.high < c.low) {
    sellScore += 15;
    sellReasons.push("Bearish FVG");
  }

  /* ORDER BLOCK */

  const bullishOB =
    c.close < c.open &&
    a.close > c.high;

  const bearishOB =
    c.close > c.open &&
    a.close < c.low;

  if (bullishOB) {
    buyScore += 15;
    buyReasons.push("Bullish OB");
  }

  if (bearishOB) {
    sellScore += 15;
    sellReasons.push("Bearish OB");
  }

  /* LIQUIDITY */

  const recent = completed.slice(-10);

  const recentHigh = Math.max(...recent.map(x => x.high));
  const recentLow = Math.min(...recent.map(x => x.low));

  if (a.high >= recentHigh && a.close < a.high) {
    sellScore += 8;
    sellReasons.push("Buy-side liquidity sweep");
  }

  if (a.low <= recentLow && a.close > a.low) {
    buyScore += 8;
    buyReasons.push("Sell-side liquidity sweep");
  }

  /* CONFIRMATION */

  const bullishCandle =
    a.close > a.open &&
    a.close > b.close;

  const bearishCandle =
    a.close < a.open &&
    a.close < b.close;

  if (bullishCandle) {
    buyScore += 15;
    buyReasons.push("Bullish confirmation");
  }

  if (bearishCandle) {
    sellScore += 15;
    sellReasons.push("Bearish confirmation");
  }

  /* VOLATILITY FILTER */

  const candleBody = Math.abs(a.close - a.open);

  if (candleBody >= range * 0.45) {
    if (a.close > a.open) {
      buyScore += 6;
      buyReasons.push("Strong body");
    } else {
      sellScore += 6;
      sellReasons.push("Strong body");
    }
  }

  const direction =
    buyScore > sellScore ? "BUY" :
    sellScore > buyScore ? "SELL" :
    null;

  if (!direction) return null;

  const confidence =
    direction === "BUY" ? buyScore : sellScore;

  if (confidence < MIN_CONFIDENCE) {
    return null;
  }

  const signalCandleTime = a.time;

  const previousSignalCandle = lastSignalCandle.get(symbol);

  if (previousSignalCandle === signalCandleTime) {
    return null;
  }

  return {
    symbol,
    name: pair.name,
    payout: pair.payout,
    direction,
    confidence,
    entry: a.close,
    candleTime: signalCandleTime,
    reasons:
      direction === "BUY"
        ? buyReasons
        : sellReasons
  };
}

/* =========================================================
   FIND BEST SIGNAL
========================================================= */

function findBestSignal() {
  const candidates = [];

  for (const pair of otcSymbols) {
    const signal = analyzePair(pair);

    if (signal) {
      candidates.push(signal);
    }
  }

  if (!candidates.length) {
    return null;
  }

  candidates.sort((a, b) => {
    // Highest strategy score first.
    if (b.confidence !== a.confidence) {
      return b.confidence - a.confidence;
    }

    // Prefer better payout if score is equal.
    return Number(b.payout || 0) - Number(a.payout || 0);
  });

  return candidates[0];
}

/* =========================================================
   SIGNAL MESSAGE
========================================================= */

function cleanPairName(name, symbol) {
  if (name) {
    return name.replace(/\s+OTC$/i, "");
  }

  return symbol.replace(/_otc$/i, "");
}

function buildSignalMessage(signal) {
  const pairName = cleanPairName(
    signal.name,
    signal.symbol
  );

  const emoji =
    signal.direction === "BUY"
      ? "🟢 BUY"
      : "🔴 SELL";

  const payout =
    signal.payout != null
      ? `${signal.payout}%`
      : "N/A";

  return `
🚨 BINARY SIGNAL 🚨

⏱ Trade Time: ${formatTime()}

💱 ${pairName} OTC → ${emoji}

⌛ Expiry: 1M

📊 Confidence: ${signal.confidence}%

💰 Current Payout: ${payout}

📈 SIGNAL RULES

🧠 SMC + FVG + ORDER BLOCK
💧 Liquidity + Confirmation
💵 Risk: ${RISK_PERCENT}% of Capital

⚠️ Confidence is a strategy score,
not a guaranteed win probability.

🔒 ONE TRADE AT A TIME
`.trim();
}

/* =========================================================
   SEND SIGNAL
========================================================= */

async function scanAndSendNext(chatId) {
  if (!isTradingSession()) return;

  if (activeSignals.has(chatId)) {
    return;
  }

  if (scanningUsers.has(chatId)) {
    return;
  }

  scanningUsers.add(chatId);

  try {
    await refreshSymbols();

    const signal = findBestSignal();

    if (!signal) {
      console.log(`🔎 No valid setup for ${chatId}`);
      return;
    }

    lastSignalCandle.set(
      signal.symbol,
      signal.candleTime
    );

    const signalId =
      `${chatId}_${signal.symbol}_${Date.now()}`;

    const expiryAt =
      Date.now() + EXPIRY_SECONDS * 1000;

    activeSignals.set(chatId, {
      id: signalId,
      chatId,
      signal,
      entry: signal.entry,
      createdAt: Date.now(),
      expiryAt
    });

    await bot.sendMessage(
      chatId,
      buildSignalMessage(signal)
    );

    console.log(
      `📤 ${chatId}: ${signal.direction} ${signal.symbol}`
    );

  } catch (err) {
    console.log(
      `❌ Scan error ${chatId}: ${err.message}`
    );
  } finally {
    scanningUsers.delete(chatId);
  }
}

/* =========================================================
   RESULT CHECK
========================================================= */

function recordResult(chatId, signal, result) {
  if (!stats.has(chatId)) {
    stats.set(chatId, {
      trades: 0,
      wins: 0,
      losses: 0,
      pairs: {}
    });
  }

  const s = stats.get(chatId);

  s.trades++;

  if (result === "WIN") {
    s.wins++;
  } else {
    s.losses++;
  }

  if (!s.pairs[signal.symbol]) {
    s.pairs[signal.symbol] = {
      trades: 0,
      wins: 0,
      losses: 0
    };
  }

  const p = s.pairs[signal.symbol];

  p.trades++;

  if (result === "WIN") {
    p.wins++;
  } else {
    p.losses++;
  }
}

async function checkResults() {
  if (!activeSignals.size) return;

  for (const [chatId, active] of activeSignals.entries()) {
    if (Date.now() < active.expiryAt) {
      continue;
    }

    const signal = active.signal;

    try {
      const data = await apiGet(
        `/v1/candles?venue=${VENUE}&symbol=${encodeURIComponent(
          signal.symbol
        )}&tf=${TIMEFRAME_SECONDS}&limit=5`
      );

      const list = data.candles || [];

      const expiryCandle = list
        .map(c => ({
          time: Number(c.time),
          close: Number(c.close)
        }))
        .filter(
          c =>
            Number.isFinite(c.time) &&
            Number.isFinite(c.close)
        )
        .sort((a, b) => a.time - b.time)
        .find(c => c.time >= signal.candleTime + 60);

      if (!expiryCandle) {
        continue;
      }

      const result =
        signal.direction === "BUY"
          ? expiryCandle.close > signal.entry
            ? "WIN"
            : "LOSS"
          : expiryCandle.close < signal.entry
            ? "WIN"
            : "LOSS";

      recordResult(chatId, signal, result);

      const resultEmoji =
        result === "WIN" ? "🏆 WIN" : "🔴 LOSS";

      await bot.sendMessage(
        chatId,
        `
🏁 TRADE RESULT

💱 ${cleanPairName(signal.name, signal.symbol)}

${signal.direction === "BUY" ? "🟢 BUY" : "🔴 SELL"}

💵 Entry: ${signal.entry}
📍 Expiry: ${expiryCandle.close}

${resultEmoji}

⏱ Expiry: 1M

🔄 Scanning all OTC currency pairs again...
`.trim()
      );

      activeSignals.delete(chatId);

      // IMPORTANT:
      // Immediately search for the next trade.
      setTimeout(() => {
        scanAndSendNext(chatId);
      }, 500);

    } catch (err) {
      console.log(
        `⚠️ Result check failed ${signal.symbol}: ${err.message}`
      );
    }
  }
}

/* =========================================================
   LIVE OTC STREAM
========================================================= */

async function startOTCStream() {
  await refreshSymbols(true);

  if (!otcSymbols.length) {
    throw new Error(
      "No Pocket Option OTC currency pairs available."
    );
  }

  const symbols = otcSymbols.map(x => x.symbol);

  const url =
    `https://otcharts.com/v1/stream` +
    `?venue=${VENUE}` +
    `&symbol=${symbols.map(encodeURIComponent).join(",")}`;

  console.log(
    `📡 Opening OTC stream for ${symbols.length} currency pairs...`
  );

  streamAbortController =
    new AbortController();

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${OTCHARTS_API_KEY}`,
      Accept: "text/event-stream"
    },
    signal: streamAbortController.signal
  });

  if (!response.ok) {
    throw new Error(
      `Stream failed: HTTP ${response.status}`
    );
  }

  if (!response.body) {
    throw new Error("OTC stream has no response body");
  }

  const reader = response.body.getReader();

  const decoder = new TextDecoder();

  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      throw new Error("OTC stream closed");
    }

    buffer += decoder.decode(value, {
      stream: true
    });

    const events = buffer.split("\n\n");

    buffer = events.pop() || "";

    for (const event of events) {
      const lines = event.split("\n");

      let eventName = "message";
      let dataText = "";

      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventName = line
            .slice(6)
            .trim();
        }

        if (line.startsWith("data:")) {
          dataText += line
            .slice(5)
            .trim();
        }
      }

      if (!dataText) continue;

      try {
        const data = JSON.parse(dataText);

        if (eventName === "connected") {
          console.log(
            `✅ OTC stream connected: ${data.symbols?.length || 0} instruments`
          );
        }

        if (eventName === "dropped") {
          console.log(
            `⚠️ OTC dropped:`,
            data.dropped
          );
        }

        if (eventName === "tick") {
          const symbol = data.symbol;
          const price = Number(data.price);
          const time = Number(data.time);

          if (
            symbol &&
            Number.isFinite(price) &&
            Number.isFinite(time)
          ) {
            addTick(symbol, price, time);
          }
        }
      } catch {
        // Ignore malformed SSE events.
      }
    }
  }
}

/* =========================================================
   AUTOMATIC SCANNER
========================================================= */

async function automaticScanner() {
  if (!isTradingSession()) {
    return;
  }

  for (const chatId of users) {
    if (!activeSignals.has(chatId)) {
      await scanAndSendNext(chatId);
    }
  }
}

/* =========================================================
   DAILY SESSION
========================================================= */

let lastSessionHour = null;

async function sessionManager() {
  const hour = lagosHour();

  if (lastSessionHour === null) {
    lastSessionHour = hour;
    return;
  }

  // 8 PM WAT — stop new signals and send report.
  if (hour === 20 && lastSessionHour !== 20) {
    for (const chatId of users) {
      await sendDailyReport(chatId);
    }

    console.log(
      "🛑 8 PM WAT — new signals stopped."
    );
  }

  // 9 PM WAT — new session.
  if (hour === 21 && lastSessionHour !== 21) {
    stats.clear();
    lastSignalCandle.clear();

    console.log(
      "🚀 9 PM WAT — new trading session started."
    );

    for (const chatId of users) {
      setTimeout(() => {
        scanAndSendNext(chatId);
      }, 1000);
    }
  }

  lastSessionHour = hour;
}

/* =========================================================
   REPORT
========================================================= */

async function sendDailyReport(chatId) {
  const s = stats.get(chatId) || {
    trades: 0,
    wins: 0,
    losses: 0,
    pairs: {}
  };

  const winRate =
    s.trades > 0
      ? ((s.wins / s.trades) * 100).toFixed(1)
      : "0.0";

  let pairText = "";

  const pairs = Object.entries(s.pairs)
    .sort((a, b) => b[1].trades - a[1].trades)
    .slice(0, 10);

  for (const [symbol, p] of pairs) {
    pairText +=
      `\n${symbol}: ${p.wins}W / ${p.losses}L`;
  }

  await bot.sendMessage(
    chatId,
    `
📊 DAILY SIGNAL REPORT

📈 Trades: ${s.trades}
🏆 Wins: ${s.wins}
🔴 Losses: ${s.losses}
🎯 Win Rate: ${winRate}%

💱 Pair Performance
${pairText || "\nNo completed trades."}

💵 Risk Setting: ${RISK_PERCENT}% of Capital

🛑 New signals stop at 8:00 PM WAT.
`.trim()
  );
}

/* =========================================================
   TELEGRAM
========================================================= */

bot.onText(/^\/start$/, async msg => {
  const chatId = msg.chat.id;

  users.add(chatId);

  await bot.sendMessage(
    chatId,
    `
🚀 BINARY SIGNAL BOT

Connected successfully.

💱 Pocket Option OTC Currency Pairs
⏱ 1-Minute Analysis
⌛ 1-Minute Expiry
🧠 SMC + FVG + Order Block
💧 Liquidity + Confirmation

🔒 ONE SIGNAL AT A TIME

After the result:
🔄 The bot scans the OTC currency pairs again.

⚠️ Signals are analytical, not guaranteed results.
`.trim()
  );

  if (isTradingSession()) {
    setTimeout(() => {
      scanAndSendNext(chatId);
    }, 1000);
  }
});

bot.onText(/^\/signal$/, msg => {
  users.add(msg.chat.id);

  scanAndSendNext(msg.chat.id);
});

bot.onText(/^\/results$/, msg => {
  const s = stats.get(msg.chat.id);

  if (!s) {
    return bot.sendMessage(
      msg.chat.id,
      "📊 No completed trades yet."
    );
  }

  const winRate =
    s.trades > 0
      ? ((s.wins / s.trades) * 100).toFixed(1)
      : "0.0";

  bot.sendMessage(
    msg.chat.id,
    `
📊 CURRENT RESULTS

Trades: ${s.trades}
🏆 Wins: ${s.wins}
🔴 Losses: ${s.losses}
🎯 Win Rate: ${winRate}%
`.trim()
  );
});

bot.onText(/^\/pairs$/, async msg => {
  try {
    const pairs = await refreshSymbols();

    const text =
      pairs
        .map(
          (p, i) =>
            `${i + 1}. ${p.name}`
        )
        .join("\n");

    await bot.sendMessage(
      msg.chat.id,
      `💱 POCKET OPTION OTC CURRENCY PAIRS\n\n${text}`
    );
  } catch (err) {
    bot.sendMessage(
      msg.chat.id,
      `❌ Could not load pairs.\n${err.message}`
    );
  }
});

bot.onText(/^\/help$/, msg => {
  bot.sendMessage(
    msg.chat.id,
    `
📚 COMMANDS

/start — Start bot
/signal — Search for next signal
/results — Current results
/pairs — OTC currency pairs
/help — Help

🔒 Only ONE active trade at a time.
`.trim()
  );
});

/* =========================================================
   HEALTH SERVER
========================================================= */

app.get("/", (req, res) => {
  res.json({
    status: "online",
    bot: "Pocket Option OTC Binary Signal Bot",
    timeframe: "1m",
    expiry: "1m",
    otcCurrencyPairs: otcSymbols.length,
    activeSignals: activeSignals.size,
    users: users.size
  });
});

/* =========================================================
   START
========================================================= */

async function start() {
  console.log("🚀 STARTING POCKET OPTION OTC SIGNAL BOT...");

  await refreshSymbols(true);

  console.log(
    `💱 OTC currency pairs available: ${otcSymbols.length}`
  );

  // Load initial candles.
  await loadHistoryForPairs();

  // Start live stream.
  startOTCStream()
    .catch(err => {
      console.log(
        `❌ OTC stream stopped: ${err.message}`
      );

      setTimeout(() => {
        startOTCStream().catch(console.error);
      }, 5000);
    });

  // Result checker.
  setInterval(
    checkResults,
    RESULT_CHECK_MS
  );

  // Finds users who have no active trade.
  setInterval(
    automaticScanner,
    SCAN_RETRY_MS
  );

  // Session manager.
  setInterval(
    sessionManager,
    30000
  );

  app.listen(PORT, () => {
    console.log(
      `🌐 Server running on port ${PORT}`
    );
  });

  console.log(
    "✅ POCKET OPTION OTC SIGNAL BOT READY"
  );
}

start().catch(err => {
  console.error(
    "💥 FATAL STARTUP ERROR:",
    err
  );

  process.exit(1);
});
