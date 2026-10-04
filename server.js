"""
XAUUSD trend-pullback signal bot -> Telegram (H4 candles)

Setup:
  pip install yfinance pandas requests
  export TG_TOKEN="your_botfather_token"
  export TG_CHAT_ID="your_chat_id"
  python xauusd_pullback_bot.py

Data: Yahoo gold futures (GC=F) used as a proxy for spot XAUUSD.
Prices differ slightly from your broker, so treat levels as approximate.
"""
import os
import time

import pandas as pd
import requests
import yfinance as yf

TOKEN = os.environ["TG_TOKEN"]
CHAT_ID = os.environ["TG_CHAT_ID"]
SYMBOL = "GC=F"
SL_ATR = 1.5      # stop loss = 1.5 x ATR
RR = 2.0          # take profit = 2 x stop distance
CHECK_EVERY = 900  # seconds
STATE_FILE = "last_signal.txt"


def get_h4():
    df = yf.download(SYMBOL, period="60d", interval="1h", progress=False, auto_adjust=True)
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    df = df[["Open", "High", "Low", "Close"]].dropna()
    h4 = df.resample("4h").agg(
        {"Open": "first", "High": "max", "Low": "min", "Close": "last"}
    ).dropna()
    return h4


def add_indicators(df):
    df["ema20"] = df["Close"].ewm(span=20, adjust=False).mean()
    df["ema50"] = df["Close"].ewm(span=50, adjust=False).mean()
    df["ema200"] = df["Close"].ewm(span=200, adjust=False).mean()

    delta = df["Close"].diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / 14, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / 14, adjust=False).mean()
    df["rsi"] = 100 - 100 / (1 + gain / loss)

    prev_close = df["Close"].shift()
    tr = pd.concat(
        [df["High"] - df["Low"], (df["High"] - prev_close).abs(), (df["Low"] - prev_close).abs()],
        axis=1,
    ).max(axis=1)
    df["atr"] = tr.ewm(alpha=1 / 14, adjust=False).mean()
    return df


def check_signal(df):
    # Last row is still forming, so use the last CLOSED candle (-2)
    c, p = df.iloc[-2], df.iloc[-3]
    recent = df.iloc[-7:-1]
    ts = df.index[-2]

    uptrend = c["Close"] > c["ema200"] and c["ema50"] > c["ema200"]
    downtrend = c["Close"] < c["ema200"] and c["ema50"] < c["ema200"]

    # BUY: uptrend, price pulled back to EMA50, RSI crossed back above 45
    if uptrend and recent["Low"].min() <= c["ema50"] and p["rsi"] < 45 <= c["rsi"]:
        entry = c["Close"]
        risk = SL_ATR * c["atr"]
        return ts, "BUY", entry, entry - risk, entry + RR * risk

    # SELL: downtrend, price pulled back to EMA50, RSI crossed back below 55
    if downtrend and recent["High"].max() >= c["ema50"] and p["rsi"] > 55 >= c["rsi"]:
        entry = c["Close"]
        risk = SL_ATR * c["atr"]
        return ts, "SELL", entry, entry + risk, entry - RR * risk

    return None


def already_sent(ts):
    return os.path.exists(STATE_FILE) and open(STATE_FILE).read().strip() == str(ts)


def send(text):
    url = f"https://api.telegram.org/bot{TOKEN}/sendMessage"
    requests.post(url, json={"chat_id": CHAT_ID, "text": text}, timeout=15)


def main():
    send("XAUUSD pullback bot started (H4).")
    while True:
        try:
            df = add_indicators(get_h4())
            sig = check_signal(df)
            if sig and not already_sent(sig[0]):
                ts, side, entry, sl, tp = sig
                send(
                    f"XAUUSD {side} (H4)\n"
                    f"Entry: {entry:.2f}\n"
                    f"SL: {sl:.2f}\n"
                    f"TP: {tp:.2f}\n"
                    f"Risk max 1% of account.\nCandle: {ts}"
                )
                open(STATE_FILE, "w").write(str(ts))
        except Exception as e:
            print("Error:", e)
        time.sleep(CHECK_EVERY)


if __name__ == "__main__":
    main()
