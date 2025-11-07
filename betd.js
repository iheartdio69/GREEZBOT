#!/usr/bin/env node
/**
 * betd.js — Polybets daemon with UI + /intel
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { execSync } = require('child_process');
const { planStake } = require('./staking-policy');

const PORT = Number(process.env.BETD_PORT || 8787);
const STATE_PATH = path.join(__dirname, 'poly-state.json');
const MARKETS_PATH = path.join(__dirname, 'markets.json');
const SNAP_PATH = path.join(__dirname, 'logs', 'market_snapshots.json');
const UI_PATH = path.join(__dirname, 'dashboard.html');

function nowIso(){ return new Date().toISOString(); }

// ----- free port -----
async function freePort(port) {
  await new Promise((resolve, reject) => {
    const tester = net.createServer()
      .once('error', err => {
        if (err.code === 'EADDRINUSE') {
          try {
            const pid = execSync(`lsof -ti :${port}`).toString().trim();
            if (pid) {
              console.log(`⚠️ Port ${port} in use by PID ${pid}, killing…`);
              try { execSync(`kill ${pid}`); } catch {}
              try { execSync(`kill -9 ${pid}`); } catch {}
              setTimeout(resolve, 400);
            } else setTimeout(resolve, 300);
          } catch { setTimeout(resolve, 500); }
        } else reject(err);
      })
      .once('listening', () => { tester.close(resolve); })
      .listen(port, '0.0.0.0');
  });
}

// ----- state -----
const DEFAULT_STATE = {
  bankroll: 100.00,
  highWater: 100.00,
  paused: false,
  pauseReason: '',
  oddsBand: { min: 1.8, max: 2.2 },
  planned: null,
  results: [],
  stats: { wins: 0, losses: 0 }
};
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return Object.assign({}, DEFAULT_STATE, s, {
      oddsBand: Object.assign({}, DEFAULT_STATE.oddsBand, s.oddsBand || {})
    });
  } catch {
    saveState(DEFAULT_STATE);
    return { ...DEFAULT_STATE };
  }
}
function saveState(s){ try{ fs.writeFileSync(STATE_PATH, JSON.stringify(s,null,2)); }catch(e){ console.error('[betd] saveState',e.message); } }
function readJsonSafe(p){ try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { return null; } }

function streak(results){
  let wins=0, losses=0;
  for (const r of results) {
    if (r.result==='W'){ if (losses) break; wins++; }
    else if (r.result==='L'){ if (wins) break; losses++; }
    else break;
  }
  return { wins, losses };
}

// ----- intel -----
function summarizeMarkets() {
  const m = readJsonSafe(MARKETS_PATH);
  const items = m?.data || [];
  const byCat = new Map();
  let active = 0;
  for (const x of items) {
    const cat = (x.category || x.Category || 'Other').trim();
    byCat.set(cat, (byCat.get(cat)||0)+1);
    if (x.active===true || x.closed===false) active++;
  }
  const cats = [...byCat.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10)
               .map(([k,v])=>({category:k,count:v}));
  const snap = readJsonSafe(SNAP_PATH);
  return {
    lastRefresh: m?.ts || null,
    source: m?.src || null,
    total: items.length,
    active,
    topCategories: cats,
    snapshots: Array.isArray(snap)? snap.slice(-10) : []
  };
}

// ----- ops -----
function doPlan(state, odds) {
  if (state.paused) return { paused:true, reason:state.pauseReason||'Paused', stake:0, fraction:0, appliedMultiplier:0, odds };
  const o = Number(odds) || ((state.oddsBand.min + state.oddsBand.max)/2);
  const plan = planStake(state.bankroll, o);
  state.planned = { ...plan, odds:o, at: nowIso() };
  saveState(state);
  return { ...plan, odds:o };
}
function doExecute(state){
  if (state.paused) return { paused:true, reason: state.pauseReason||'Paused' };
  if (!state.planned) return { error:'Nothing planned. Use /plan first.' };
  const orderId = 'paper-'+Math.random().toString(36).slice(2,10);
  return { order:{ id:orderId, ts: nowIso() }, planned: { ...state.planned } };
}
function doResult(state, body){
  const res = String(body.result||'').toUpperCase();
  if (res!=='W' && res!=='L') return { error:'result must be "W" or "L"' };
  const odds = Number(body.odds)||Number(state?.planned?.odds)||((state.oddsBand.min+state.oddsBand.max)/2);
  const stake = Number(state?.planned?.stake)||Number(body.stake)||0.1;
  const pnl = res==='W' ? stake*(odds-1) : -stake;

  state.bankroll = Math.max(0, Number((state.bankroll + pnl).toFixed(2)));
  if (state.bankroll > state.highWater) state.highWater = state.bankroll;

  const entry = { ts:nowIso(), result:res, stake:Number(stake.toFixed(2)), odds:Number(odds.toFixed(3)),
                  pnl:Number(pnl.toFixed(2)), bankrollAfter: state.bankroll };
  state.results.unshift(entry); if (state.results.length>5000) state.results.length=5000;
  if (res==='W') state.stats.wins++; else state.stats.losses++;
  state.planned = null; saveState(state);
  return { ...entry, wins:state.stats.wins, losses:state.stats.losses };
}
function doPause(state,reason){ state.paused=true; state.pauseReason=reason||'Paused by user'; saveState(state); return { paused:true, reason:state.pauseReason }; }
function doResume(state){ state.paused=false; state.pauseReason=''; saveState(state); return { paused:false }; }
function setOddsBand(state,min,max){
  const a=Number(min), b=Number(max);
  if (!Number.isFinite(a)||!Number.isFinite(b)||a<1.01||b<=a) return { error:'Bad odds band. Use numbers like {min:1.4,max:3.0}' };
  state.oddsBand={min:a,max:b}; saveState(state); return state.oddsBand;
}
function buildStatus(state){
  const sk = streak(state.results);
  return { bankroll:state.bankroll, highWater:state.highWater, paused:state.paused, pauseReason:state.pauseReason||null,
           oddsBand:state.oddsBand, planned:state.planned, results:state.results.slice(0,10), stats:state.stats, streak:sk };
}
function buildReport(state){
  const n = state.stats.wins + state.stats.losses;
  const winrate = n? (state.stats.wins/n):0;
  const pnl = state.results.reduce((a,r)=>a+(r.pnl||0),0);
  return { bankroll:state.bankroll, highWater:state.highWater, totalBets:n, wins:state.stats.wins, losses:state.stats.losses,
           winrate:Number((winrate*100).toFixed(2)), pnlAll:Number(pnl.toFixed(2)), last20: state.results.slice(0,20) };
}

// ----- http helpers -----
function sendJson(res,code,obj){ const s=JSON.stringify(obj); res.writeHead(code,{'Content-Type':'application/json'}); res.end(s); }
function parseBody(req){
  return new Promise((resolve,reject)=>{
    let data=''; req.on('data',c=>data+=c);
    req.on('end',()=>{ if(!data) return resolve({}); try{ resolve(JSON.parse(data)); }catch(e){ reject(new Error(`Invalid JSON: ${e.message}`)); } });
    req.on('error', reject);
  });
}

// ----- server -----
async function main(){
  await freePort(PORT);

  const server = http.createServer(async (req,res)=>{
    const url = new URL(req.url, `http://${req.headers.host}`);
    const method = req.method;
    const state = loadState();

    // CORS
    if (method==='OPTIONS'){
      res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'}); 
      return res.end();
    }
    res.setHeader('Access-Control-Allow-Origin','*');

    try {
      if (method==='GET' && url.pathname==='/ui'){
        const html = fs.readFileSync(UI_PATH,'utf8'); res.writeHead(200,{'Content-Type':'text/html'}); return res.end(html);
      }
      if (method==='GET' && url.pathname==='/status') return sendJson(res,200,buildStatus(state));
      if (method==='GET' && url.pathname==='/intel')  return sendJson(res,200,summarizeMarkets());
      if (method==='GET' && url.pathname==='/report') return sendJson(res,200,buildReport(state));

      if (method==='POST' && url.pathname==='/plan'){ const b=await parseBody(req).catch(e=>({__error:e})); if(b?.__error) return sendJson(res,400,{error:b.__error.message}); return sendJson(res,200,doPlan(state, Number(b.odds))); }
      if (method==='POST' && url.pathname==='/execute'){ const out=doExecute(state); return sendJson(res, out.error?400:200, out); }
      if (method==='POST' && url.pathname==='/result'){ const b=await parseBody(req).catch(e=>({__error:e})); if(b?.__error) return sendJson(res,400,{error:b.__error.message}); const out=doResult(state,b); return sendJson(res, out.error?400:200, out); }
      if (method==='POST' && url.pathname==='/pause'){ const b=await parseBody(req).catch(()=>({})); return sendJson(res,200,doPause(state,b.reason)); }
      if (method==='POST' && url.pathname==='/resume'){ return sendJson(res,200,doResume(state)); }
      if (method==='POST' && url.pathname==='/oddsband'){ const b=await parseBody(req).catch(e=>({__error:e})); if(b?.__error) return sendJson(res,400,{error:b.__error.message}); const out=setOddsBand(state,b.min,b.max); return sendJson(res, out.error?400:200, out); }

      sendJson(res,404,{error:'not found'});
    } catch(e){
      console.error('[betd] error:', e); sendJson(res,500,{error:e.message});
    }
  });

  server.listen(PORT, ()=> console.log(`[betd] listening on http://localhost:${PORT}  |  UI: /ui`));
  process.on('SIGINT', ()=>{ console.log('\n[betd] shutting down…'); server.close(()=>process.exit(0)); });
}
main().catch(e=>{ console.error('💥 Failed to start betd:', e.message); process.exit(1); });