#!/usr/bin/env node
// staking-policy.js — bankroll-aware staking with hot/cold adjustments

const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, 'poly-state.json'); // reuse your existing state file if you want

// ---- Tunables (safe defaults) ----
const CFG = {
  baseUnit: 0.1,           // your "I'm poor" minimum unit; all stakes are >= this
  minStake: 0.1,           // absolute floor
  maxStakePct: 0.02,       // hard cap per bet: 2% of bankroll
  kellyFraction: 0.25,     // use 1/4 Kelly (safer)
  defaultEdge: 0.02,       // 2% edge if we don't have a model
  hotStreak: { wins: 3, boost: 1.2 },   // 3 straight wins -> x1.2
  coldStreak: { losses: 2, cut: 0.7 },  // 2 straight losses -> x0.7
};

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return { bankroll: 100, results: [] }; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); } catch {}
}

function kellyFractionDecimalOdds(p, b) {
  // Kelly f* = (bp - q)/b where b = odds-1, p=prob of win, q=1-p
  const q = 1 - p;
  const f = (b * p - q) / b;
  return Math.max(0, f); // no negative staking
}

function streakInfo(results) {
  // results: most-recent first array of 'W'/'L'
  let w = 0, l = 0;
  for (const r of results) {
    if (r === 'W') { if (l > 0) break; w++; }
    else if (r === 'L') { if (w > 0) break; l++; }
    else break;
  }
  return { wins: w, losses: l };
}

/**
 * Plan a stake given bankroll & decimal odds.
 * @param {number} bankroll
 * @param {number} odds (decimal)
 * @param {number} [edge]  (optional; if omitted uses CFG.defaultEdge)
 * @param {object} [state] (optional injected state)
 * @returns { stake, fraction, appliedMultiplier, notes[] }
 */
function planStake(bankroll, odds, edge, state) {
  const s = state || loadState();
  const notes = [];

  const b = Math.max(1.0001, odds) - 1; // b = odds - 1
  const impliedP = 1 / odds;
  const p = Math.min(0.99, Math.max(0.01, impliedP + (edge ?? CFG.defaultEdge)));

  const rawKelly = kellyFractionDecimalOdds(p, b);
  const f = Math.min(rawKelly * CFG.kellyFraction, CFG.maxStakePct);
  const baseStake = Math.max(CFG.minStake, CFG.baseUnit, bankroll * f);

  let stake = baseStake;
  notes.push(`kellyRaw=${rawKelly.toFixed(4)} f=${f.toFixed(4)} base=${baseStake.toFixed(4)}`);

  // hot/cold streak multiplier
  const streak = streakInfo(s.results || []);
  let mult = 1.0;
  if (streak.wins >= CFG.hotStreak.wins) { mult *= CFG.hotStreak.boost; notes.push(`hot x${CFG.hotStreak.boost}`); }
  if (streak.losses >= CFG.coldStreak.losses) { mult *= CFG.coldStreak.cut; notes.push(`cold x${CFG.coldStreak.cut}`); }

  stake *= mult;
  // clamp again to maxStakePct of bankroll
  const cap = bankroll * CFG.maxStakePct;
  if (stake > cap) { stake = cap; notes.push(`cap ${CFG.maxStakePct*100}%`); }
  if (stake < CFG.minStake) { stake = CFG.minStake; notes.push(`floor ${CFG.minStake}`); }

  // round to sensible cents (or base units)
  stake = Math.max(CFG.baseUnit, Math.round(stake * 100) / 100);

  return { stake, fraction: stake / bankroll, appliedMultiplier: mult, notes };
}

// Simple CLI for quick checks:
//   node staking-policy.js 100 1.95
if (require.main === module) {
  const bankroll = Number(process.argv[2] || 100);
  const odds = Number(process.argv[3] || 1.95);
  const plan = planStake(bankroll, odds);
  console.log(JSON.stringify(plan, null, 2));
}

module.exports = { planStake, CFG, loadState, saveState };

