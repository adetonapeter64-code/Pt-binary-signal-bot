const TelegramBot=require('node-telegram-bot-api');
const express=require('express');
const axios=require('axios');
const app=express(); const PORT=process.env.PORT||3000;
const TOKEN=process.env.BOT_TOKEN, API=process.env.TWELVE_DATA_API_KEY, CHAT_ID=process.env.CHAT_ID||'';
if(!TOKEN||!API){console.error('Missing BOT_TOKEN or TWELVE_DATA_API_KEY');process.exit(1)}
const bot=new TelegramBot(TOKEN,{polling:true});
const SYMBOL='XAU/USD', INTERVAL='5min';
const SWING=2, ATR_PERIOD=14, BREAK_ATR=.05, MIN_BODY_ATR=.20, RR=2, COOLDOWN=3;
const subs=new Set(CHAT_ID?[String(CHAT_ID)]:[]); let lastCandle=null,lastSignalCandle=null,lastDir=null,lastSignal=null,status='Starting...';
const f=n=>Number(n).toFixed(2);
async function candles(){const r=await axios.get('https://api.twelvedata.com/time_series',{params:{symbol:SYMBOL,interval:INTERVAL,outputsize:150,apikey:API,format:'JSON'},timeout:15000});if(r.data.status==='error')throw Error(r.data.message);return r.data.values.map(x=>({time:new Date(x.datetime).getTime(),open:+x.open,high:+x.high,low:+x.low,close:+x.close})).sort((a,b)=>a.time-b.time)}
function ATR(a,p=ATR_PERIOD){if(a.length<p+1)return null;let x=[];for(let i=1;i<a.length;i++)x.push(Math.max(a[i].high-a[i].low,Math.abs(a[i].high-a[i-1].close),Math.abs(a[i].low-a[i-1].close)));x=x.slice(-p);return x.reduce((s,v)=>s+v,0)/x.length}
function swings(a){let H=[],L=[];for(let i=SWING;i<a.length-SWING;i++){let h=true,l=true;for(let j=1;j<=SWING;j++){if(a[i].high<=a[i-j].high||a[i].high<a[i+j].high)h=false;if(a[i].low>=a[i-j].low||a[i].low>a[i+j].low)l=false}if(h)H.push({i,p:a[i].high});if(l)L.push({i,p:a[i].low})}return{H,L}}
function analyze(all){const now=Date.now(),a=all.filter(x=>x.time+300000<=now);if(a.length<60)return{};const c=a.at(-1),body=Math.abs(c.close-c.open),atr=ATR(a);if(!atr)return{};const {H,L}=swings(a.slice(0,-1));if(H.length<2||L.length<2)return{};const h1=H.at(-2).p,h2=H.at(-1).p,l1=L.at(-2).p,l2=L.at(-1).p;const bias=h2>h1&&l2>l1?'BULLISH':h2<h1&&l2<l1?'BEARISH':'NEUTRAL',R=H.at(-1).p,S=L.at(-1).p;
if(body<atr*MIN_BODY_ATR)return{c,reason:`No setup | ${bias}`};
if(bias==='BULLISH'&&c.close>R+atr*BREAK_ATR&&c.close>c.open){let sl=Math.min(c.low,S)-atr*.15,r=c.close-sl;return{c,s:{direction:'BUY',entry:c.close,sl,tp1:c.close+r*1.5,tp2:c.close+r*RR,level:R,atr,bias}};
if(bias==='BEARISH'&&c.close<S-atr*BREAK_ATR&&c.close<c.open){let sl=Math.max(c.high,R)+atr*.15,r=sl-c.close;return{c,s:{direction:'SELL',entry:c.close,sl,tp1:c.close-r*1.5,tp2:c.close-r*RR,level:S,atr,bias}}}
return{c,reason:`No confirmed setup | Bias ${bias} | R ${f(R)} | S ${f(S)}`}}
function msg(s){let e=s.direction==='BUY'?'🟢':'🔴';return `${e} XAUUSD M5 ${s.direction} SIGNAL\n\n📍 Entry: ${f(s.entry)}\n🛑 SL: ${f(s.sl)}\n🎯 TP1: ${f(s.tp1)}\n🎯 TP2: ${f(s.tp2)}\n\n📊 Strategy: M5 Structure + Breakout + Confirmation\n📈 Bias: ${s.bias}\n💧 Level: ${f(s.level)}\n📐 ATR: ${f(s.atr)}\n\n⚠️ Rules-based signal; no profit guarantee.`}
async function check(){try{const a=await candles(),r=analyze(a);if(!r.c)return; if(lastCandle===r.c.time)return;lastCandle=r.c.time;status=r.reason||'Signal detected';if(!r.s){console.log(status);return}let bars=a.findIndex(x=>x.time===lastSignalCandle);if(lastSignalCandle&&a.length-1-bars<COOLDOWN){status='Signal blocked by cooldown';return}if(lastDir===r.s.direction){status='Same-direction signal blocked';return}lastSignalCandle=r.c.time;lastDir=r.s.direction;lastSignal=r.s;status=`${r.s.direction} signal sent`;for(const id of subs)try{await bot.sendMessage(id,msg(r.s))}catch(e){console.error(e.message)}console.log(msg(r.s))}catch(e){status='Data error: '+e.message;console.error(status)}}
setInterval(check,30000);check();
bot.onText(/^\/start$/,async m=>{subs.add(String(m.chat.id));await bot.sendMessage(m.chat.id,'🤖 XAUUSD M5 SIGNAL BOT\n\nLive M5 analysis is active.\n\nStrategy:\n• Market structure\n• Swing highs/lows\n• Breakout confirmation\n• Candle-body confirmation\n• ATR-based SL/TP\n\nCommands:\n/status\n/signal\n/stop')});
bot.onText(/^\/stop$/,async m=>{subs.delete(String(m.chat.id));await bot.sendMessage(m.chat.id,'🔕 Notifications stopped. Send /start to subscribe again.')});
bot.onText(/^\/status$/,async m=>bot.sendMessage(m.chat.id,`🛰 XAUUSD M5 STATUS\n\n${status}\n\n⏱ Checks every 30 seconds\n🕯 Signals only after closed M5 candles`));
bot.onText(/^\/signal$/,async m=>bot.sendMessage(m.chat.id,lastSignal?msg(lastSignal):'⏳ No confirmed signal yet.'));
app.get('/',(_,res)=>res.json({ok:true,bot:'XAUUSD M5 Signal Bot',status}));app.listen(PORT,()=>console.log('Web server on '+PORT));
