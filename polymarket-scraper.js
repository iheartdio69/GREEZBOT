#!/usr/bin/env node
// polymarket-scraper.js — resilient local search over markets.json (percent-safe, with fallback)
// Usage:
//   node polymarket-scraper.js "sol" 1.3 3.5
//   node polymarket-scraper.js "" 1.3 3.5
//   node polymarket-scraper.js "" 1.01 100  (wide band sanity)

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'markets.json');

function readMarkets() {
  const raw = fs.readFileSync(FILE, 'utf8');
  const j = JSON.parse(raw);
  if (Array.isArray(j)) return j;
  if (Array.isArray(j.data)) return j.data;
  for (const v of Object.values(j || {})) if (Array.isArray(v)) return v;
  return [];
}

const lc = (s) => (s || '').toString().toLowerCase();
function toNum(x) {
  if (typeof x === 'number') return x;
  if (typeof x === 'string') {
    const trimmed = x.trim();
    if (trimmed.endsWith('%')) {
      const n = Number(trimmed.slice(0, -1));
      return Number.isFinite(n) ? n : NaN;
    }
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

// Convert a raw numeric/string value to probability in (0,1)
// Accepts: 0..1 (already prob), 1..100 (percent), "42%", etc.
function normalizeProb(v) {
  const n = toNum(v);
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n < 1) return n;             // already a probability
  if (n > 1 && n <= 100) return n / 100;    // percentage style
  if (n === 1) return 1 - 1e-6;             // avoid inf odds
  if (n === 0) return 1e-6;
  return null;
}

function textOf(m) {
  return [
    m.question, m.title, m.name, m.slug, m.ticker, m.category, m.description
  ].filter(Boolean).join(' ').toLowerCase();
}

// robust probability extractor from an outcome-like object
function outcomeProb(o) {
  // prefer explicit prob/price fields
  for (const k of ['lastPrice', 'price', 'mid', 'prob', 'probability']) {
    const p = normalizeProb(o?.[k]);
    if (p != null && p > 0 && p < 1) return p;
  }
  // bid/ask → mid
  const bidN = normalizeProb(o?.bestBid ?? o?.bid);
  const askN = normalizeProb(o?.bestAsk ?? o?.ask);
  if (bidN != null && askN != null && askN >= bidN && bidN > 0 && askN < 1) {
    const mid = (bidN + askN) / 2;
    if (mid > 0 && mid < 1) return mid;
  }
  // any 0..1 or percent-ish field as last resort
  for (const k of Object.keys(o || {})) {
    const p = normalizeProb(o[k]);
    if (p != null && p > 0 && p < 1) return p;
  }
  return null;
}

function marketCandidates(m) {
  const outcomes = Array.isArray(m.outcomes) ? m.outcomes : [];
  const liq = toNum(m.liquidityNum || m.openInterest || m.liquidity || 0) || 0;
  const title = m.question || m.title || m.name || '(untitled)';
  const url = m.url || m.link ||
    (m.slug ? `https://polymarket.com/market/${m.slug}` :
     (m.ticker ? `https://polymarket.com/market/${m.ticker}` : null));

  const out = [];
  for (const o of outcomes) {
    const p0 = outcomeProb(o);
    if (p0 == null) continue;

    // clamp away from 0/1 to avoid infinite odds
    const p = Math.min(0.999999, Math.max(0.000001, p0));
    const yesOdds = 1 / p;
    const noOdds  = 1 / (1 - p);

    const name = o.name || o.outcome || 'Outcome';
    const base = {
      marketId: m.id || m.slug || m.conditionId || '',
      title, url, outcome: name,
      liquidity: liq,
      active: !!(m.active ?? true)
    };

    out.push({
      ...base,
      side: 'YES',
      prob: Number(p.toFixed(6)),
      odds: Number(yesOdds.toFixed(3))
    });
    out.push({
      ...base,
      side: 'NO',
      prob: Number((1 - p).toFixed(6)),
      odds: Number(noOdds.toFixed(3))
    });
  }
  return out;
}

function makeQueryRegex(q) {
  if (!q) return null;
  const s = q.trim().toLowerCase();
  if (s === 'sol') return new RegExp(`\\b(sol|solana|\\$?sol)\\b`, 'i');
  if (s === 'btc' || s === 'bitcoin') return new RegExp(`\\b(btc|bitcoin|\\$?btc)\\b`, 'i');
  if (s === 'eth' || s === 'ethereum') return new RegExp(`\\b(eth|ethereum|\\$?eth)\\b`, 'i');
  // default: escaped substring
  return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

function search({ q, minOdds, maxOdds, limit }) {
  const markets = readMarkets();
  const re = makeQueryRegex(q || '');
  const hits = [];
  const pool = [];

  for (const m of markets) {
    if (m.closed === true) continue;
    if (m.archived === true) continue;
    if (m.active === false) continue;

    const cands = marketCandidates(m)
      .filter(c => Number.isFinite(c.odds) && c.odds >= minOdds && c.odds <= maxOdds);

    if (!cands.length) continue;

    // collect for fallback
    pool.push(...cands);

    if (re) {
      const blob = textOf(m);
      if (!re.test(blob)) continue;
    }

    // prefer higher liquidity
    cands.sort((a, b) => b.liquidity - a.liquidity);
    for (const c of cands) {
      hits.push(c);
      if (hits.length >= limit) break;
    }
    if (hits.length >= limit) break;
  }

  if (hits.length) return hits.slice(0, limit);

  // Fallback: no keyword matches — return top by liquidity within band
  pool.sort((a, b) => b.liquidity - a.liquidity);
  return pool.slice(0, limit);
}

// CLI
if (require.main === module) {
  const q = process.argv[2] || '';
  const minOdds = Number(process.argv[3] || 1.4);
  const maxOdds = Number(process.argv[4] || 3.0);
  const limit = Number(process.argv[5] || 12);
  try {
    const out = search({ q, minOdds, maxOdds, limit });
    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    console.error('❌ scraper error:', e.message);
    process.exit(1);
  }
}

module.exports = { search };
