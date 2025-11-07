#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(process.cwd(), 'poly-state.json');

function nowISO() { return new Date().toISOString(); }
function loadState() { if (!fs.existsSync(STATE_FILE)) return null; return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x.startsWith('--')) {
      const k = x.slice(2);
      const v = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
      a[k] = v;
    } else a._.push(x);
  }
  return a;
}
function toNum(x, d) { if (x === undefined) return d; const n = Number(x); return Number.isNaN(n) ? d : n; }

function defaultConfig() {
  return {
    bankroll: 1000, baseKelly: 0.07, odds: 1.9, window: 5,
    aggression: { "0": 0.5, "1": 0.5, "2": 0.5, "3": 1.0, "4": 1.25, "5": 1.5 },
    maxFraction: 0.13, minFraction: 0.02,
    hotBonusOnPureStreak: 1.75, drawdownPause: 0.15, dailyExposureCap: 0.20, currency: 'USD'
  };
}
function dayKey(d) { return d.toISOString().slice(0, 10); }
function freshState() {
  const cfg = defaultConfig();
  return {
    createdAt: nowISO(),
    config: cfg,
    bankroll: cfg.bankroll,
    highWater: cfg.bankroll,
    paused: false, pauseReason: null,
    exposureToday: 0, exposureDayAnchor: dayKey(new Date()),
    results: [], pendingStake: null
  };
}
function ensureDayExposureBucket(s) {
  const k = dayKey(new Date());
  if (s.exposureDayAnchor !== k) { s.exposureDayAnchor = k; s.exposureToday = 0; }
}
function recentWins(s, n) { return s.results.slice(0, n).filter(r => r.result === 'W').length; }

function planStake(s, { odds } = {}) {
  if (s.paused) return { paused: true, reason: s.pauseReason };
  ensureDayExposureBucket(s);
  const c = s.config;
  const wins = recentWins(s, c.window);
  const mult = c.aggression[String(Math.min(wins, c.window))] ?? 1.0;
  const pure = wins === c.window;
  const hot = pure ? c.hotBonusOnPureStreak : 1;
  let frac = c.baseKelly * mult * hot;
  frac = Math.min(c.maxFraction, Math.max(c.minFraction, frac));

  const dayStart = s.highWater ? Math.min(s.highWater, s.bankroll / (1 - c.drawdownPause)) : s.bankroll;
  const cap = dayStart * c.dailyExposureCap;
  const remain = Math.max(0, cap - s.exposureToday);

  let stake = s.bankroll * frac;
  if (stake > remain) {
    if (remain <= 0) return { paused: true, reason: 'Daily exposure cap hit.' };
    stake = remain;
  }
  stake = Math.round(stake * 100) / 100;
  return { paused: false, stake, fraction: stake / s.bankroll, winsInWindow: wins, pureStreak: pure, odds: odds || c.odds, appliedMultiplier: (mult * hot).toFixed(2) };
}

function applyResult(s, result, odds) {
  if (s.paused) return s;
  const plan = s.pendingStake || planStake(s, { odds });
  if (plan.paused) return s;
  const o = Number.isFinite(odds) ? odds : s.config.odds;
  const pnl = (result === 'W') ? plan.stake * (o - 1) : -plan.stake;

  s.exposureToday += plan.stake;
  s.bankroll = Math.round((s.bankroll + pnl) * 100) / 100;
  s.highWater = Math.max(s.highWater, s.bankroll);
  s.results.unshift({ ts: nowISO(), result, stake: plan.stake, odds: o, pnl: Math.round(pnl * 100) / 100, bankrollAfter: s.bankroll });
  s.pendingStake = null;

  const dd = (s.highWater - s.bankroll) / s.highWater;
  if (dd >= s.config.drawdownPause) { s.paused = true; s.pauseReason = `Drawdown ${Math.round(dd * 100)}%`; }
  return s;
}

function printPlan(p, c) {
  if (p.paused) return console.log(`⏸️  ${p.reason}`);
  console.log(`Stake: ${c} ${p.stake} (${(p.fraction * 100).toFixed(2)}%)  Odds ${p.odds}  x${p.appliedMultiplier}`);
}
function status(s) {
  const c = s.config;
  const w = s.results.filter(r => r.result === 'W').length;
  const l = s.results.filter(r => r.result === 'L').length;
  const t = w + l;
  const wr = t ? (w / t) : 0;
  console.log(`Bankroll ${c.currency} ${s.bankroll} | HWM ${s.highWater} | WR ${(wr * 100).toFixed(2)}%`);
  if (s.paused) console.log(`⏸️  ${s.pauseReason}`);
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = parseArgs(rest);
  if (!cmd) return console.log('Commands: init, plan, win, loss, status, reset, resume');

  if (cmd === 'init') {
    const s = freshState();
    s.config.baseKelly = toNum(a.baseKelly, 0.07);
    s.config.odds = toNum(a.odds, 1.9);
    s.bankroll = toNum(a.bankroll, 1000);
    s.highWater = s.bankroll;
    saveState(s);
    return console.log('✅ Initialized bankroll', s.bankroll);
  }

  let s = loadState();
  if (!s) return console.error('No state. Run init first.');

  switch (cmd) {
    case 'plan': {
      const p = planStake(s, { odds: toNum(a.odds) });
      printPlan(p, s.config.currency);
      if (!p.paused) s.pendingStake = p;
      saveState(s); break;
    }
    case 'win': s = applyResult(s, 'W', toNum(a.odds)); saveState(s); status(s); break;
    case 'loss': s = applyResult(s, 'L', toNum(a.odds)); saveState(s); status(s); break;
    case 'status': status(s); break;
    case 'resume': s.paused = false; s.pauseReason = null; saveState(s); console.log('▶️ resumed'); break;
    case 'reset': saveState(freshState()); console.log('🔄 reset'); break;
  }
})();
