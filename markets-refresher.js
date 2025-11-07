#!/usr/bin/env node
/**
 * markets-refresher.js
 * Fetch Polymarket markets with embedded outcomes/prices and write markets.json
 * Tries CLOB with outcomes/orderbook, then falls back to Gamma API.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'markets.json');

// 150s + jitter by default (when --watch)
const BASE_SEC = Number(process.env.REFRESH_SEC || 150);

const SOURCES = [
  // CLOB with binary outcomes included
  'https://clob.polymarket.com/markets?active=true&limit=1000&withBinaryOutcomes=true',
  // CLOB with orderbook (some envs)
  'https://clob.polymarket.com/markets?active=true&limit=1000&withOrderBook=true',
  // Gamma API fallback
  'https://gamma-api.polymarket.com/markets?active=true&limit=1000'
];

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          resolve(j);
        } catch (e) {
          reject(new Error(`parse error for ${url}: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`timeout for ${url}`));
    });
  });
}

function toNum(x) {
  if (typeof x === 'number') return x;
  if (typeof x === 'string') {
    const n = Number(x);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/** Normalize one market into `{ ... , outcomes:[{name, bestBid, bestAsk, lastPrice}] }` */
function normalizeMarket(m) {
  const n = { ...m };

  // Case A: CLOB gives binaryOutcomes: [{ name, bestBid, bestAsk, lastPrice }]
  if (Array.isArray(m.binaryOutcomes)) {
    n.outcomes = m.binaryOutcomes.map(o => ({
      name: o.name || o.outcome || 'Outcome',
      bestBid: toNum(o.bestBid ?? o.bid),
      bestAsk: toNum(o.bestAsk ?? o.ask),
      lastPrice: toNum(o.lastPrice ?? o.price ?? o.mid)
    }));
    return n;
  }

  // Case B: CLOB with orderBooks
  if (Array.isArray(m.orderBooks) && m.orderBooks.length) {
    n.outcomes = m.orderBooks.map(ob => ({
      name: ob.outcome || ob.name || 'Outcome',
      bestBid: toNum(ob.bestBid ?? ob.bid),
      bestAsk: toNum(ob.bestAsk ?? ob.ask),
      lastPrice: toNum(ob.mid ?? ob.lastPrice ?? ob.price)
    }));
    return n;
  }

  // Case C: Gamma API with outcomes/outcomePrices
  if (Array.isArray(m.outcomePrices) && m.outcomePrices.length >= 2) {
    const names = Array.isArray(m.outcomes) ? m.outcomes : ['Yes', 'No'];
    n.outcomes = m.outcomePrices.map((p, i) => {
      const prob = toNum(p); // 0..1
      // synthesize bid/ask around lastPrice a tiny bit so we have mid/bounds
      const last = prob;
      const spr = 0.01;
      return {
        name: names[i] || `O${i}`,
        bestBid: Math.max(0, Math.min(1, last - spr)),
        bestAsk: Math.max(0, Math.min(1, last + spr)),
        lastPrice: last
      };
    });
    return n;
  }

  // Case D: Already has outcomes array
  if (Array.isArray(m.outcomes)) {
    n.outcomes = m.outcomes.map(o => ({
      name: o.name || o.outcome || 'Outcome',
      bestBid: toNum(o.bestBid ?? o.bid),
      bestAsk: toNum(o.bestAsk ?? o.ask),
      lastPrice: toNum(o.lastPrice ?? o.price ?? o.mid)
    }));
    return n;
  }

  // Fallback: give a synthetic single outcome if we have any 0..1 price on the market
  const p =
    toNum(m.lastPrice) || toNum(m.price) || toNum(m.mid) || NaN;
  if (p > 0 && p < 1) {
    n.outcomes = [{
      name: 'Outcome',
      bestBid: Math.max(0, Math.min(1, p - 0.01)),
      bestAsk: Math.max(0, Math.min(1, p + 0.01)),
      lastPrice: p
    }];
  }

  return n;
}

async function fetchOnce() {
  for (const url of SOURCES) {
    try {
      const j = await getJSON(url);
      const arr = Array.isArray(j) ? j : (Array.isArray(j.data) ? j.data : null);
      if (!arr || !arr.length) {
        continue;
      }
      const normalized = arr.map(normalizeMarket);
      const withOutcomes = normalized.filter(x => Array.isArray(x.outcomes) && x.outcomes.length);
      if (!withOutcomes.length) continue;

      const out = { data: withOutcomes };
      fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
      console.log(`[markets-refresher] wrote ${withOutcomes.length} markets (active≈${withOutcomes.filter(m => m.active ?? true).length}) from ${url}`);
      return true;
    } catch (e) {
      console.error('[markets-refresher] source error:', e.message);
    }
  }
  console.error('[markets-refresher] all sources failed or contained no outcomes.');
  return false;
}

async function main() {
  const watch = process.argv.includes('--watch');
  if (!watch) {
    const ok = await fetchOnce();
    process.exit(ok ? 0 : 1);
  }
  // watch loop
  console.log(`[markets-refresher] watching every ~${BASE_SEC}s (with jitter)`);
  while (true) {
    await fetchOnce();
    const jitter = 0.5 + Math.random(); // 0.5x…1.5x
    const ms = Math.round(BASE_SEC * 1000 * jitter);
    await new Promise(r => setTimeout(r, ms));
  }
}

if (require.main === module) {
  main().catch(e => {
    console.error('[markets-refresher] fatal:', e);
    process.exit(1);
  });
}
