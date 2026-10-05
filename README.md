# XAUUSD M5 Telegram Signal Bot

Gets XAU/USD M5 candles from Twelve Data and checks every 30 seconds, acting only after a completed M5 candle.

Strategy: confirmed swing structure (HH+HL or LH+LL) + breakout beyond latest swing + candle-body confirmation + ATR-based SL/TP. TP1=1.5R, TP2=2R. Cooldown blocks repeated signals.

Render: Build `npm install`; Start `npm start`; add BOT_TOKEN and TWELVE_DATA_API_KEY. Optional CHAT_ID auto-subscribes one chat. Telegram users can also send /start.
