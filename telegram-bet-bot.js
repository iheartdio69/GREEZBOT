#!/usr/bin/env node
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const http = require('http');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) { console.error('❌ Missing BOT_TOKEN in .env'); process.exit(1); }

const API = 'http://localhost:8787';
const bot = new Telegraf(TOKEN);

// ---- helpers ----
function post(path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${API}${path}`, { method:'POST', headers:{'Content-Type':'application/json'}}, res => {
      let data=''; res.on('data',d=>data+=d);
      res.on('end',()=>{ try{ resolve(JSON.parse(data||'{}')); } catch(e){ reject(e); } });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body||{})); req.end();
  });
}
function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`${API}${path}`, res => {
      let data=''; res.on('data',d=>data+=d);
      res.on('end',()=>{ try{ resolve(JSON.parse(data||'{}')); } catch(e){ reject(e); } });
    }).on('error', reject);
  });
}
function fmt(n){ return Number(n).toLocaleString(undefined,{ maximumFractionDigits: 2}); }

// ---- menu ----
const menu = () => Markup.keyboard([
  ['/status','/intel'],
  ['/plan 1.92','/go'],
  ['/w 1.92','/l 1.92'],
  ['/odds 1.4 3.0','/pause','/resume'],
  ['/polyfind','/polyfind sol']
]).resize();

// ---- commands ----
bot.start(ctx => ctx.reply('🤖 Polytale Bet Bot ready.\nUse /menu to show shortcuts.', menu()));

bot.command('menu', ctx => ctx.reply('Menu:', menu()));

bot.command('status', async ctx => {
  const s = await get('/status');
  const lines = [];
  lines.push(`💰 Bankroll: ${fmt(s.bankroll)}  |  HWM: ${fmt(s.highWater)}`);
  lines.push(`🎯 Odds band: [${s.oddsBand.min}-${s.oddsBand.max}]`);
  lines.push(`${s.paused ? '⏸️ Paused' : '▶️ Active'}`);
  lines.push(`Recent:`);
  (s.results||[]).forEach(r=>{
    lines.push(`${r.result}  ${fmt(r.stake)}@${r.odds}  → ${r.pnl>0?'+':''}${fmt(r.pnl)}   (bk ${fmt(r.bankrollAfter)})`);
  });
  return ctx.reply(lines.join('\n'));
});

bot.command('intel', async ctx => {
  const i = await get('/intel');
  const cats = (i.topCategories||[]).map((c,idx)=>`${idx+1}. ${c.category} – ${c.count}`).join('\n') || '—';
  const msg = [
    `📊 *Intel*`,
    `Last: \`${i.lastRefresh||'—'}\``,
    `Total: *${i.total}*  (active≈${i.active})`,
    ``,
    `*Top categories*`,
    cats
  ].join('\n');
  return ctx.replyWithMarkdownV2(msg);
});

bot.command('plan', async ctx => {
  const arg = (ctx.message.text.split(' ')[1]||'').trim();
  const odds = Number(arg);
  const out = await post('/plan', { odds: Number.isFinite(odds)?odds:undefined });
  if (out.paused) return ctx.reply(`⏸️ Paused: ${out.reason||''}`);
  return ctx.reply(`🧮 Stake ${fmt(out.stake)} (${(out.fraction*100).toFixed(2)}%) @ ${out.odds}\nnotes: ${out.notes?.join(' | ')||'—'}`);
});

bot.command('go', async ctx => {
  const out = await post('/execute');
  if (out.error) return ctx.reply(`❌ ${out.error}`);
  return ctx.reply(`📤 Paper order ${out.order.id} placed for ${fmt(out.planned.stake)} @ ${out.planned.odds}`);
});

bot.command('w', async ctx => {
  const arg = (ctx.message.text.split(' ')[1]||'').trim();
  const odds = Number(arg);
  const out = await post('/result', { result:'W', odds: Number.isFinite(odds)?odds:undefined });
  if (out.error) return ctx.reply(`❌ ${out.error}`);
  return ctx.reply(`✅ WIN  +${fmt(out.pnl)}  (bk ${fmt(out.bankrollAfter)})`);
});

bot.command('l', async ctx => {
  const arg = (ctx.message.text.split(' ')[1]||'').trim();
  const odds = Number(arg);
  const out = await post('/result', { result:'L', odds: Number.isFinite(odds)?odds:undefined });
  if (out.error) return ctx.reply(`❌ ${out.error}`);
  return ctx.reply(`❌ LOSS  ${fmt(out.pnl)}  (bk ${fmt(out.bankrollAfter)})`);
});

bot.command('pause', async ctx => {
  const reason = ctx.message.text.split(' ').slice(1).join(' ');
  const out = await post('/pause', { reason });
  return ctx.reply(`⏸️ Paused ${out.reason?`(${out.reason})`:''}`);
});

bot.command('resume', async ctx => {
  const out = await post('/resume', {});
  return ctx.reply(`▶️ Resumed`);
});

bot.command('odds', async ctx => {
  const parts = ctx.message.text.split(' ').slice(1).map(Number);
  const [min,max] = parts;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return ctx.reply('Usage: /odds 1.4 3.0');
  const out = await post('/oddsband',{min,max});
  if (out.error) return ctx.reply(`❌ ${out.error}`);
  return ctx.reply(`🎯 Odds band set to [${out.min}-${out.max}]`);
});

// (Your existing /polyfind handler remains unchanged if you already have it)

// errors
bot.catch(err => console.error('[bot] error:', err));
bot.launch().then(()=>console.log('[bot] launched'));