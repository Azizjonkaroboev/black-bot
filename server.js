'use strict';

/* ============================================================
   BLACK — Telegram Mini App backend
   Node.js + Express + grammY + Supabase
   Все секреты берутся из переменных окружения Amvera.
   ============================================================ */

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { Bot } = require('grammy');

// ---------- ENV ----------
const BOT_TOKEN      = process.env.BOT_TOKEN;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
const ADMIN_ID       = Number(process.env.ADMIN_ID || 0);
const PLATFORM_WALLET= process.env.PLATFORM_WALLET || 'UQAG8cx9dXAWIfcoNUkdyki-Un9QzJxw3_xU8624H6OnZFMb';
const CHANNEL        = (process.env.CHANNEL_URL || 'https://t.me/blackt_channel').split('/').pop();
const SUPPORT_URL    = process.env.SUPPORT_URL || 'https://t.me/Ventlp';
const WEBAPP_URL     = process.env.WEBAPP_URL || 'https://black-bot-azizjonkaroboev1.amvera.io';
const BOT_USERNAME   = process.env.BOT_USERNAME || 'black_tonbot';

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('FATAL: BOT_TOKEN / SUPABASE_URL / SUPABASE_KEY не заданы в переменных окружения');
}

const ARC_USD = 0.0003;       // 1 ARC = $0.0003
const PVP_MIN = 10;
const PVP_MAX = 1000;
const PVP_FEE = 0.10;         // 10% сгорает
const PVP_MAX_PLAYERS = 10;
const WAIT_MS = 60000;        // 60 сек ожидания 2-го игрока
const COUNTDOWN_MS = 15000;   // 15 сек отсчёт
const AD_REWARD = 5;          // +5 ARC за просмотр (база, до множителя)
const REF_L1 = 0.20;          // 20% уровень 1
const REF_L2 = 0.10;          // 10% уровень 2

// Слоты рекламы (все выключены пока)
const AD_SLOTS = {
  1: { name: 'Adsgram',   active: false, max: 50 },
  2: { name: 'Richads',   active: false, max: 50 },
  3: { name: 'Реклама 3', active: false, max: 30 },
  4: { name: 'Реклама 4', active: false, max: 30 },
  5: { name: 'Реклама 5', active: false, max: 30 }
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const bot = new Bot(BOT_TOKEN);

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// ---------- HELPERS ----------
function moscowDate(d = new Date()) {
  return d.toLocaleString('en-CA', { timeZone: 'Europe/Moscow' }).split(',')[0];
}
function yesterdayMoscow() {
  const d = new Date(); d.setDate(d.getDate() - 1);
  return moscowDate(d);
}
function nowISO() { return new Date().toISOString(); }
function notifyAdmin(text) {
  if (ADMIN_ID) bot.api.sendMessage(ADMIN_ID, text).catch(() => {});
}

// ---------- AUTH ----------
function verifyInitData(initData) {
  if (!initData) return false;
  try {
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    const checkString = [...params.entries()].sort().map(([k, v]) => `${k}=${v}`).join('\n');
    const calc = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
    return calc === hash;
  } catch (e) { return false; }
}
function getUserFromInit(initData) {
  try {
    const params = new URLSearchParams(initData);
    const raw = params.get('user');
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

// Middleware: проверяет initData для защищённых маршрутов
function auth(req, res, next) {
  const open = ['/api/pvp/state', '/api/ton-rate', '/api/exchange/status', '/api/tasks', '/api/leaderboard', '/api/pvp/history'];
  if (open.includes(req.path) || req.method === 'GET' && req.path.startsWith('/api/user/')) {
    // GET /api/user/:id тоже проверим мягко (нужен для отображения)
  }
  if (open.includes(req.path)) return next();
  const initData = req.headers['x-telegram-init-data'] || req.body?.initData;
  if (!verifyInitData(initData)) return res.status(401).json({ error: 'auth' });
  const u = getUserFromInit(initData);
  if (!u) return res.status(401).json({ error: 'no user' });
  req.tgUser = u;
  // Запрет действовать от чужого имени
  if (req.body?.telegram_id && String(req.body.telegram_id) !== String(u.id)) {
    return res.status(403).json({ error: 'id mismatch' });
  }
  next();
}
app.use(auth);

// ---------- TON RATE ----------
let tonRateUSD = 3.0;
async function fetchTonRate() {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd');
    const d = await r.json();
    if (d['the-open-network']?.usd) tonRateUSD = d['the-open-network'].usd;
  } catch (e) {}
}
fetchTonRate();
setInterval(fetchTonRate, 10 * 60 * 1000);

function arcPerTon() { return Math.floor(tonRateUSD / ARC_USD); }

// ---------- USER REGISTRATION / REFERRAL ----------
async function ensureUser(tgUser, startParam) {
  const tgId = String(tgUser.id);
  const { data: existing } = await supabase.from('users').select('telegram_id').eq('telegram_id', tgId).single();
  if (!existing) {
    await supabase.from('users').insert({
      telegram_id: tgId,
      username: tgUser.username || tgUser.first_name || 'User',
      first_name: tgUser.first_name || '',
      photo_url: tgUser.photo_url || '',
      ref_code: tgId,
      arc_balance: 0, ton_balance: 0, multiplier: 1.0,
      checkin_day: 1, checkin_done: false, last_checkin_date: '',
      last_app_open: nowISO(), last_decay_date: '', inactive_days: 0
    });
    // Реферальная привязка
    if (startParam) {
      const refId = String(startParam).replace(/^ref_/, '');
      if (refId && refId !== tgId) {
        const { data: ref } = await supabase.from('users').select('telegram_id').eq('telegram_id', refId).single();
        if (ref) {
          // уровень 1
          await supabase.from('referrals').insert({ referrer_id: refId, referred_id: tgId, level: 1, earned_arc: 0 });
          notifyAdmin(`👥 Новый реферал у ${refId}: @${tgUser.username || tgUser.first_name}`);
          bot.api.sendMessage(Number(refId), `👥 Новый реферал: @${tgUser.username || tgUser.first_name}!`).catch(() => {});
          // уровень 2 — реферер того, кто пригласил
          const { data: up } = await supabase.from('referrals').select('referrer_id').eq('referred_id', refId).eq('level', 1).single();
          if (up && up.referrer_id && up.referrer_id !== tgId) {
            await supabase.from('referrals').insert({ referrer_id: up.referrer_id, referred_id: tgId, level: 2, earned_arc: 0 });
          }
        }
      }
    }
  } else {
    await supabase.from('users').update({
      last_seen: nowISO(),
      username: tgUser.username || tgUser.first_name || 'User',
      photo_url: tgUser.photo_url || ''
    }).eq('telegram_id', tgId);
  }
}

// Начисление реферальных бонусов с заработка на рекламе
async function payReferralBonus(earnerId, baseArc) {
  // L1
  const { data: r1 } = await supabase.from('referrals').select('referrer_id,earned_arc').eq('referred_id', earnerId).eq('level', 1).single();
  if (r1?.referrer_id) {
    const b1 = Math.floor(baseArc * REF_L1);
    if (b1 > 0) {
      const { data: u1 } = await supabase.from('users').select('arc_balance').eq('telegram_id', r1.referrer_id).single();
      if (u1) {
        await supabase.from('users').update({ arc_balance: Number(u1.arc_balance) + b1 }).eq('telegram_id', r1.referrer_id);
        await supabase.from('referrals').update({ earned_arc: Number(r1.earned_arc || 0) + b1 }).eq('referred_id', earnerId).eq('level', 1);
      }
    }
  }
  // L2
  const { data: r2 } = await supabase.from('referrals').select('referrer_id,earned_arc').eq('referred_id', earnerId).eq('level', 2).single();
  if (r2?.referrer_id) {
    const b2 = Math.floor(baseArc * REF_L2);
    if (b2 > 0) {
      const { data: u2 } = await supabase.from('users').select('arc_balance').eq('telegram_id', r2.referrer_id).single();
      if (u2) {
        await supabase.from('users').update({ arc_balance: Number(u2.arc_balance) + b2 }).eq('telegram_id', r2.referrer_id);
        await supabase.from('referrals').update({ earned_arc: Number(r2.earned_arc || 0) + b2 }).eq('referred_id', earnerId).eq('level', 2);
      }
    }
  }
}

// ============================================================
//  PvP ENGINE
// ============================================================
const COLORS = ['#3b82f6','#ef4444','#22c55e','#f59e0b','#a855f7','#06b6d4','#ec4899','#84cc16','#f97316','#14b8a6'];

let round = newRound(1);
function newRound(id) {
  return { id, status: 'waiting', players: [], totalPool: 0, countdownEnd: null, waitTimer: null, winner: null };
}
function assignColor(players) {
  const used = new Set(players.map(p => p.color));
  for (const c of COLORS) if (!used.has(c)) return c;
  return COLORS[players.length % COLORS.length];
}

function startWaitTimer() {
  if (round.waitTimer) clearTimeout(round.waitTimer);
  round.waitTimer = setTimeout(async () => {
    if (round.players.length === 1 && round.status === 'waiting') {
      const solo = round.players[0];
      // вернуть ставку
      const { data: u } = await supabase.from('users').select('arc_balance').eq('telegram_id', solo.telegram_id).single();
      if (u) await supabase.from('users').update({ arc_balance: Number(u.arc_balance) + solo.bet }).eq('telegram_id', solo.telegram_id);
      bot.api.sendMessage(Number(solo.telegram_id), '⏰ Ставка возвращена — соперник не пришёл за 60 секунд.').catch(() => {});
      // СЧЁТЧИК НЕ ДВИГАЕМ — игры не было
      round = newRound(round.id);
    }
  }, WAIT_MS);
}

function startCountdown() {
  if (round.status !== 'waiting') return;
  round.status = 'countdown';
  round.countdownEnd = Date.now() + COUNTDOWN_MS;
  if (round.waitTimer) clearTimeout(round.waitTimer);
}

async function finishRound() {
  if (round.status !== 'countdown' || Date.now() < round.countdownEnd) return;
  round.status = 'spinning';
  const total = round.totalPool;
  if (!total || round.players.length < 2) { round = newRound(round.id); return; }

  // выбор победителя по весу ставки
  let rnd = Math.random() * total, winner = null;
  for (const p of round.players) { rnd -= p.bet; if (rnd <= 0) { winner = p; break; } }
  if (!winner) winner = round.players[round.players.length - 1];

  const fee = Math.floor(total * PVP_FEE);   // сгорает
  const winAmount = total - fee;
  const chance = Number(((winner.bet / total) * 100).toFixed(2));

  const { data: wu } = await supabase.from('users').select('arc_balance').eq('telegram_id', winner.telegram_id).single();
  await supabase.from('users').update({ arc_balance: Number(wu?.arc_balance || 0) + winAmount }).eq('telegram_id', winner.telegram_id);
  await supabase.from('transactions').insert({ telegram_id: winner.telegram_id, type: 'pvp_win', amount: winAmount, currency: 'ARC', description: `PvP раунд #${round.id}`, created_at: nowISO() });

  // total_pvp_bet для лидерборда
  for (const p of round.players) {
    const { data: pu } = await supabase.from('users').select('total_pvp_bet').eq('telegram_id', p.telegram_id).single();
    await supabase.from('users').update({ total_pvp_bet: Number(pu?.total_pvp_bet || 0) + p.bet }).eq('telegram_id', p.telegram_id);
  }

  await supabase.from('pvp_rounds').insert({
    round_id: round.id, winner_id: winner.telegram_id, winner_name: winner.username,
    winner_amount: winAmount, total_pool: total, fee,
    players: round.players.map(p => ({ telegram_id: p.telegram_id, username: p.username, bet: p.bet }))
  });

  bot.api.sendMessage(Number(winner.telegram_id), `🏆 Победа в PvP #${round.id}! +${winAmount} ARC (шанс ${chance}%)`).catch(() => {});

  round.winner = { telegram_id: winner.telegram_id, username: winner.username, amount: winAmount, chance };
  round.status = 'finished';

  // показываем 4 сек, потом новый раунд +1 (игра состоялась)
  const finishedId = round.id;
  setTimeout(() => { round = newRound(finishedId + 1); }, 4000);
}
setInterval(() => { if (round.status === 'countdown' && Date.now() >= round.countdownEnd) finishRound(); }, 100);

// ---------- PvP API ----------
app.get('/api/pvp/state', (req, res) => {
  const countdown = round.status === 'countdown'
    ? Math.max(0, Math.ceil((round.countdownEnd - Date.now()) / 1000)) : null;
  res.json({
    roundId: round.id,
    status: round.status,
    totalPool: round.totalPool,
    countdown,
    maxPlayers: PVP_MAX_PLAYERS,
    players: round.players.map(p => ({
      telegram_id: p.telegram_id, username: p.username, bet: p.bet, color: p.color,
      photo: p.photo || '',
      chance: Number(((p.bet / Math.max(round.totalPool, 1)) * 100).toFixed(2))
    })),
    winner: round.winner
  });
});

app.post('/api/pvp/join', async (req, res) => {
  try {
    const tgId = String(req.tgUser.id);
    const amt = parseInt(req.body.bet);
    if (isNaN(amt) || amt < PVP_MIN) return res.status(400).json({ error: `Минимум ${PVP_MIN} ARC` });
    if (amt > PVP_MAX) return res.status(400).json({ error: `Максимум ${PVP_MAX} ARC` });
    if (round.status === 'spinning' || round.status === 'finished') return res.status(400).json({ error: 'Раунд завершается, подождите' });

    const { data: user } = await supabase.from('users').select('arc_balance,username,photo_url').eq('telegram_id', tgId).single();
    if (!user || Number(user.arc_balance) < amt) return res.status(400).json({ error: 'Недостаточно ARC' });

    const existing = round.players.find(p => p.telegram_id === tgId);
    if (!existing && round.players.length >= PVP_MAX_PLAYERS) return res.status(400).json({ error: 'Максимум 10 игроков' });

    await supabase.from('users').update({ arc_balance: Number(user.arc_balance) - amt }).eq('telegram_id', tgId);

    if (existing) {
      existing.bet += amt;
    } else {
      round.players.push({
        telegram_id: tgId,
        username: user.username || req.tgUser.username || 'Player',
        photo: user.photo_url || req.tgUser.photo_url || '',
        bet: amt,
        color: assignColor(round.players)
      });
    }
    round.totalPool += amt;

    if (round.players.length === 1) startWaitTimer();
    if (round.players.length >= 2 && round.status === 'waiting') startCountdown();

    res.json({ ok: true, balance: Number(user.arc_balance) - amt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pvp/history', async (req, res) => {
  try {
    const { data } = await supabase.from('pvp_rounds').select('*').order('id', { ascending: false }).limit(30);
    res.json(data || []);
  } catch (e) { res.json([]); }
});

// ============================================================
//  USER API
// ============================================================
app.post('/api/me', async (req, res) => {
  try {
    const { initData } = req.body;
    if (!verifyInitData(initData)) return res.status(401).json({ error: 'auth' });
    const u = getUserFromInit(initData);
    const params = new URLSearchParams(initData);
    await ensureUser(u, params.get('start_param') || '');
    // Вход в Mini App — сбрасываем счётчик неактивности
    await supabase.from('users').update({
      last_app_open: nowISO(), inactive_days: 0, last_decay_date: ''
    }).eq('telegram_id', String(u.id));
    res.json({ id: u.id, username: u.username || '', first_name: u.first_name || '', photo_url: u.photo_url || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/user/:tgId', async (req, res) => {
  try {
    const tgId = String(req.params.tgId);
    const { data } = await supabase.from('users').select('*').eq('telegram_id', tgId).single();
    if (!data) return res.json({ arc_balance: 0, ton_balance: 0, multiplier: 1.0 });

    const today = moscowDate();
    const checkin_done = data.last_checkin_date === today;

    // друзья (оба уровня) с заработком
    const { data: refs } = await supabase.from('referrals')
      .select('referred_id,earned_arc,level').eq('referrer_id', tgId).order('level', { ascending: true });
    let friends = [];
    if (refs && refs.length) {
      const ids = refs.map(r => r.referred_id);
      const { data: us } = await supabase.from('users').select('telegram_id,username,photo_url').in('telegram_id', ids);
      const map = {}; (us || []).forEach(x => map[x.telegram_id] = x);
      friends = refs.map(r => ({
        telegram_id: r.referred_id,
        username: map[r.referred_id]?.username || 'User',
        photo: map[r.referred_id]?.photo_url || '',
        earned_arc: Number(r.earned_arc || 0),
        level: r.level || 1
      }));
    }
    const directCount = (refs || []).filter(r => r.level === 1).length;

    const { data: txs } = await supabase.from('transactions').select('*').eq('telegram_id', tgId).order('created_at', { ascending: false }).limit(50);
    const { data: adRows } = await supabase.from('ad_views').select('ad_slot,views_count').eq('telegram_id', tgId).eq('view_date', today);
    const ads_today = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    (adRows || []).forEach(v => ads_today[v.ad_slot] = v.views_count);

    res.json({
      telegram_id: data.telegram_id,
      username: data.username,
      photo_url: data.photo_url,
      arc_balance: Number(data.arc_balance) || 0,
      ton_balance: Number(data.ton_balance) || 0,
      multiplier: Number(data.multiplier) || 1.0,
      checkin_day: data.checkin_day || 1,
      checkin_done,
      exc_today: Number(data.exc_today) || 0,
      wallet_addr: data.wallet_addr || '',
      friends,
      direct_count: directCount,
      transactions: txs || [],
      ads_today
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
//  CHECK-IN  (множитель на рекламу, раз в день по МСК)
// ============================================================
app.post('/api/checkin', async (req, res) => {
  try {
    const tgId = String(req.tgUser.id);
    const { data: user } = await supabase.from('users').select('*').eq('telegram_id', tgId).single();
    if (!user) return res.status(400).json({ error: 'Не найден' });

    const today = moscowDate();
    if (user.last_checkin_date === today) return res.status(400).json({ error: 'already_done' });

    let day = user.checkin_day || 1;
    // если последний чек-ин был не вчера и не пусто — стрик сбрасывается
    if (user.last_checkin_date && user.last_checkin_date !== yesterdayMoscow()) day = 1;

    const multiplier = Math.min(1.0 + (day - 1) * 0.1, 1.5);
    const nextDay = day >= 6 ? 1 : day + 1;

    await supabase.from('users').update({
      checkin_done: true,
      checkin_day: nextDay,
      multiplier,
      last_checkin_date: today
    }).eq('telegram_id', tgId);

    res.json({ ok: true, day, multiplier });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
//  ADS
// ============================================================
app.post('/api/ad/view', async (req, res) => {
  try {
    const tgId = String(req.tgUser.id);
    const slot = parseInt(req.body.ad_slot) || 1;
    const cfg = AD_SLOTS[slot];
    if (!cfg || !cfg.active) return res.status(400).json({ error: 'Реклама недоступна' });

    const today = moscowDate();
    const { data: existing } = await supabase.from('ad_views').select('*').eq('telegram_id', tgId).eq('ad_slot', slot).eq('view_date', today).single();
    const views = existing?.views_count || 0;
    if (views >= cfg.max) return res.status(400).json({ error: 'Дневной лимит' });

    if (existing) await supabase.from('ad_views').update({ views_count: views + 1 }).eq('id', existing.id);
    else await supabase.from('ad_views').insert({ telegram_id: tgId, ad_slot: slot, view_date: today, views_count: 1 });

    const { data: user } = await supabase.from('users').select('arc_balance,multiplier').eq('telegram_id', tgId).single();
    const mult = Number(user?.multiplier) || 1.0;
    const earned = Math.floor(AD_REWARD * mult);
    await supabase.from('users').update({ arc_balance: Number(user?.arc_balance || 0) + earned }).eq('telegram_id', tgId);
    await supabase.from('transactions').insert({ telegram_id: tgId, type: 'ad_reward', amount: earned, currency: 'ARC', description: `Реклама ${cfg.name}: +${earned} ARC`, created_at: nowISO() });

    await payReferralBonus(tgId, earned);
    res.json({ ok: true, arc_earned: earned, views: views + 1, max: cfg.max });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
//  PROMO
// ============================================================
app.post('/api/promo/use', async (req, res) => {
  try {
    const tgId = String(req.tgUser.id);
    const code = (req.body.code || '').toUpperCase().trim();
    if (!code) return res.status(400).json({ error: 'Введите код' });

    const { data: promo } = await supabase.from('promos').select('*').eq('code', code).eq('active', true).single();
    if (!promo) return res.status(400).json({ error: 'Промокод не найден' });
    if (promo.expires_at && new Date(promo.expires_at) < new Date()) return res.status(400).json({ error: 'Промокод истёк' });
    if (promo.current_uses >= promo.max_uses) return res.status(400).json({ error: 'Лимит исчерпан' });

    const { data: used } = await supabase.from('promo_uses').select('id').eq('promo_code', code).eq('telegram_id', tgId).single();
    if (used) return res.status(400).json({ error: 'Вы уже использовали этот код' });

    const { data: user } = await supabase.from('users').select('arc_balance').eq('telegram_id', tgId).single();
    if (!user) return res.status(400).json({ error: 'Не найден' });

    // защита от гонки: вставляем использование (уникальный индекс)
    const { error: insErr } = await supabase.from('promo_uses').insert({ promo_code: code, telegram_id: tgId });
    if (insErr) return res.status(400).json({ error: 'Вы уже использовали этот код' });

    await supabase.from('users').update({ arc_balance: Number(user.arc_balance) + promo.arc_amount }).eq('telegram_id', tgId);
    await supabase.from('promos').update({ current_uses: promo.current_uses + 1 }).eq('code', code);
    await supabase.from('transactions').insert({ telegram_id: tgId, type: 'promo', amount: promo.arc_amount, currency: 'ARC', description: `Промокод ${code}`, created_at: nowISO() });

    res.json({ ok: true, arc_amount: promo.arc_amount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
//  TASKS
// ============================================================
app.get('/api/tasks', async (req, res) => {
  try {
    const { data } = await supabase.from('tasks').select('*').eq('active', true).order('created_at', { ascending: false });
    const now = new Date();
    const list = (data || []).filter(t => {
      if (t.expires_at && new Date(t.expires_at) < now) return false;
      if (t.max_completions > 0 && t.current_completions >= t.max_completions) return false;
      return true;
    });
    res.json(list);
  } catch (e) { res.json([]); }
});

app.get('/api/task-done/:tgId', async (req, res) => {
  try {
    const { data } = await supabase.from('task_completions').select('task_id').eq('telegram_id', String(req.params.tgId));
    res.json({ done: (data || []).map(x => x.task_id) });
  } catch (e) { res.json({ done: [] }); }
});

app.post('/api/task/complete', async (req, res) => {
  try {
    const tgId = String(req.tgUser.id);
    const taskId = parseInt(req.body.task_id);
    const { data: task } = await supabase.from('tasks').select('*').eq('id', taskId).eq('active', true).single();
    if (!task) return res.status(400).json({ error: 'Задание не найдено' });
    if (task.expires_at && new Date(task.expires_at) < new Date()) return res.status(400).json({ error: 'Задание истекло' });
    if (task.max_completions > 0 && task.current_completions >= task.max_completions) return res.status(400).json({ error: 'Лимит исчерпан' });

    const { data: done } = await supabase.from('task_completions').select('id').eq('task_id', taskId).eq('telegram_id', tgId).single();
    if (done) return res.status(400).json({ error: 'Уже выполнено' });

    if (task.task_type === 'subscribe' && task.channel_username) {
      try {
        const member = await bot.api.getChatMember('@' + task.channel_username.replace('@', ''), Number(tgId));
        if (!['member', 'administrator', 'creator'].includes(member.status)) return res.status(400).json({ error: 'Вы не подписаны' });
      } catch (e) { return res.status(400).json({ error: 'Не удалось проверить подписку' }); }
    }

    const { error: insErr } = await supabase.from('task_completions').insert({ task_id: taskId, telegram_id: tgId });
    if (insErr) return res.status(400).json({ error: 'Уже выполнено' });

    const { data: user } = await supabase.from('users').select('arc_balance').eq('telegram_id', tgId).single();
    await supabase.from('users').update({ arc_balance: Number(user?.arc_balance || 0) + task.arc_reward }).eq('telegram_id', tgId);
    await supabase.from('tasks').update({ current_completions: task.current_completions + 1 }).eq('id', taskId);
    await supabase.from('transactions').insert({ telegram_id: tgId, type: 'task', amount: task.arc_reward, currency: 'ARC', description: `Задание: ${task.title}`, created_at: nowISO() });

    res.json({ ok: true, arc_reward: task.arc_reward });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/check-subscription', async (req, res) => {
  try {
    const tgId = String(req.tgUser.id);
    const channel = (req.body.channel || CHANNEL).replace('@', '');
    const member = await bot.api.getChatMember('@' + channel, Number(tgId));
    res.json({ subscribed: ['member', 'administrator', 'creator'].includes(member.status) });
  } catch (e) { res.json({ subscribed: false }); }
});

// ============================================================
//  EXCHANGE  (TON -> ARC only)
// ============================================================
app.get('/api/ton-rate', (req, res) => res.json({ rate: tonRateUSD, arc_per_ton: arcPerTon() }));

app.get('/api/exchange/status', async (req, res) => {
  res.json({ ton_to_arc: true, arc_to_ton: false, arc_per_ton: arcPerTon(), ton_rate: tonRateUSD, daily_limit: 5 });
});

app.post('/api/exchange', async (req, res) => {
  try {
    const tgId = String(req.tgUser.id);
    const tonAmt = parseFloat(req.body.ton_amount);
    if (isNaN(tonAmt) || tonAmt < 0.1) return res.status(400).json({ error: 'Минимум 0.1 TON' });
    const { data: user } = await supabase.from('users').select('ton_balance,arc_balance,exc_today').eq('telegram_id', tgId).single();
    if (!user || Number(user.ton_balance) < tonAmt) return res.status(400).json({ error: 'Недостаточно TON' });
    if (Number(user.exc_today || 0) + tonAmt > 5) return res.status(400).json({ error: 'Лимит 5 TON в день' });

    const arcAmount = Math.floor(tonAmt * arcPerTon());
    await supabase.from('users').update({
      ton_balance: Number(user.ton_balance) - tonAmt,
      arc_balance: Number(user.arc_balance) + arcAmount,
      exc_today: Number(user.exc_today || 0) + tonAmt
    }).eq('telegram_id', tgId);
    await supabase.from('transactions').insert({ telegram_id: tgId, type: 'exchange', amount: arcAmount, currency: 'ARC', description: `Обмен ${tonAmt} TON → ${arcAmount} ARC`, created_at: nowISO() });
    res.json({ ok: true, arc_credited: arcAmount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
//  WALLET
// ============================================================
app.post('/api/wallet/connect', async (req, res) => {
  try {
    await supabase.from('users').update({ wallet_addr: req.body.wallet_addr || '' }).eq('telegram_id', String(req.tgUser.id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/wallet/disconnect', async (req, res) => {
  try {
    await supabase.from('users').update({ wallet_addr: '' }).eq('telegram_id', String(req.tgUser.id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
//  DEPOSIT (auto, via tx_hash) / WITHDRAW (manual)
// ============================================================
app.post('/api/check-deposit', async (req, res) => {
  try {
    const tgId = String(req.tgUser.id);
    const { data } = await supabase.from('transactions').select('amount').eq('telegram_id', tgId).eq('type', 'deposit').eq('currency', 'TON').order('created_at', { ascending: false }).limit(1).single();
    if (!data) return res.json({ confirmed: false });
    const expected = parseFloat(req.body.expected_ton);
    res.json({ confirmed: expected ? Number(data.amount) >= expected - 1e-6 : true, amount: data.amount });
  } catch (e) { res.json({ confirmed: false }); }
});

async function monitorDeposits() {
  try {
    const r = await fetch(`https://toncenter.com/api/v2/getTransactions?address=${PLATFORM_WALLET}&limit=20`);
    const data = await r.json();
    for (const tx of data.result || []) {
      const txHash = tx.transaction_id?.hash;
      if (!txHash) continue;
      const { data: ex } = await supabase.from('transactions').select('id').eq('tx_hash', txHash).single();
      if (ex) continue;
      const msg = tx.in_msg || {};
      let comment = msg.message || msg.msg_data?.text || '';
      try {
        const buf = Buffer.from(comment, 'base64');
        const dec = buf.readUInt32BE(0) === 0 ? buf.subarray(4).toString('utf8') : buf.toString('utf8');
        if (dec.includes('black_dep_')) comment = dec;
      } catch (e) {}
      const match = comment.match(/black_dep_(\d+)/);
      if (!match) continue;
      const uid = match[1];
      const amt = Number(msg.value) / 1e9;
      if (amt < 0.1) continue;
      const { data: user } = await supabase.from('users').select('ton_balance').eq('telegram_id', uid).single();
      if (!user) continue;
      // вставка с хэшем — уникальный индекс не даст задвоить
      const { error: insErr } = await supabase.from('transactions').insert({ telegram_id: uid, type: 'deposit', amount: amt, currency: 'TON', tx_hash: txHash, description: `Депозит ${amt.toFixed(3)} TON`, created_at: nowISO() });
      if (insErr) continue;
      await supabase.from('users').update({ ton_balance: Number(user.ton_balance || 0) + amt }).eq('telegram_id', uid);
      bot.api.sendMessage(Number(uid), `✅ Депозит зачислен: +${amt.toFixed(3)} TON`).catch(() => {});
      notifyAdmin(`💰 Депозит\n👤 ${uid}\n💎 ${amt.toFixed(3)} TON\n🔗 ${txHash}`);
    }
  } catch (e) {}
}
setInterval(monitorDeposits, 5000);
monitorDeposits();

app.post('/api/withdraw-request', async (req, res) => {
  try {
    const tgId = String(req.tgUser.id);
    const amt = parseFloat(req.body.ton_amount);
    const wallet = req.body.wallet || '';
    if (isNaN(amt) || amt < 0.1) return res.status(400).json({ error: 'Минимум 0.1 TON' });
    const { data: user } = await supabase.from('users').select('ton_balance,wallet_addr').eq('telegram_id', tgId).single();
    if (!user || Number(user.ton_balance) < amt) return res.status(400).json({ error: 'Недостаточно TON' });

    await supabase.from('users').update({ ton_balance: Number(user.ton_balance) - amt }).eq('telegram_id', tgId);
    await supabase.from('transactions').insert({ telegram_id: tgId, type: 'withdraw', amount: amt, currency: 'TON', status: 'pending', wallet_addr: wallet || user.wallet_addr, description: `Вывод ${amt} TON`, created_at: nowISO() });

    const when = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    notifyAdmin(`⬆️ ЗАЯВКА НА ВЫВОД\n👤 @${req.tgUser.username || req.tgUser.first_name}\n🆔 ${tgId}\n💎 ${amt} TON\n👛 ${wallet || user.wallet_addr}\n🕒 ${when} МСК\n⏳ Обработать в течение 24 часов`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
//  LEADERBOARD
// ============================================================
app.get('/api/leaderboard', async (req, res) => {
  try {
    const type = req.query.type || 'pvp';
    const myId = req.query.tg_id || '';
    if (type === 'pvp') {
      const { data } = await supabase.from('users').select('telegram_id,username,photo_url,total_pvp_bet').order('total_pvp_bet', { ascending: false }).limit(200);
      const all = (data || []).map((u, i) => ({ rank: i + 1, name: u.username, photo: u.photo_url, val: u.total_pvp_bet || 0, tid: u.telegram_id }));
      return res.json({ top: all.slice(0, 50), me: myId ? all.find(u => String(u.tid) === String(myId)) || null : null });
    }
    // ads
    const { data: rows } = await supabase.from('ad_views').select('telegram_id,views_count');
    const map = {};
    (rows || []).forEach(v => map[v.telegram_id] = (map[v.telegram_id] || 0) + v.views_count);
    const ids = Object.keys(map);
    const { data: us } = ids.length ? await supabase.from('users').select('telegram_id,username,photo_url').in('telegram_id', ids) : { data: [] };
    const umap = {}; (us || []).forEach(u => umap[u.telegram_id] = u);
    const all = Object.entries(map).sort((a, b) => b[1] - a[1]).map(([tid, val], i) => ({ rank: i + 1, name: umap[tid]?.username || tid, photo: umap[tid]?.photo_url || '', val, tid }));
    res.json({ top: all.slice(0, 50), me: myId ? all.find(u => String(u.tid) === String(myId)) || null : null });
  } catch (e) { res.json({ top: [], me: null }); }
});

// ============================================================
//  BOT COMMANDS
// ============================================================
bot.command('start', async (ctx) => {
  const startParam = ctx.match || '';
  await ensureUser(ctx.from, startParam);
  const name = ctx.from?.first_name || 'there';
  const text =
    `🖤 *Welcome to BLACK, ${name}!*\n\n` +
    `Earn *ARC* coins and exchange them for *TON* crypto.\n\n` +
    `⚔️ Play PvP and win ARC\n` +
    `📺 Watch ads & complete tasks\n` +
    `👥 Invite friends — earn forever\n\n` +
    `Tap the button below to start 👇`;
  await ctx.reply(text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '🚀 Open BLACK', web_app: { url: WEBAPP_URL } }],
      [{ text: '📢 Channel', url: 'https://t.me/' + CHANNEL }, { text: '💬 Support', url: SUPPORT_URL }]
    ] }
  });
});

const isAdmin = ctx => ctx.from?.id === ADMIN_ID;

// /addpromo КОД ARC ЛИМИТ [дни]
bot.command('addpromo', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const [code, arc, limit, days] = (ctx.match || '').trim().split(/\s+/);
  if (!code || !arc || !limit) return ctx.reply('Формат: /addpromo КОД ARC ЛИМИТ [дни]\nПример: /addpromo BLACK100 100 500 7\n(дни не указывать = бессрочно)');
  const expires = days ? new Date(Date.now() + parseInt(days) * 864e5).toISOString() : null;
  const { error } = await supabase.from('promos').insert({ code: code.toUpperCase(), arc_amount: parseInt(arc), max_uses: parseInt(limit), current_uses: 0, active: true, expires_at: expires });
  if (error) return ctx.reply('Ошибка: ' + error.message);
  ctx.reply(`✅ Промокод ${code.toUpperCase()} | ${arc} ARC | лимит ${limit}${days ? ' | ' + days + 'дн' : ' | бессрочно'}`);
});

bot.command('delpromo', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const code = (ctx.match || '').trim().toUpperCase();
  if (!code) return ctx.reply('Формат: /delpromo КОД');
  await supabase.from('promos').update({ active: false }).eq('code', code);
  ctx.reply(`🗑 Промокод ${code} удалён`);
});

bot.command('listpromos', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const { data } = await supabase.from('promos').select('*').eq('active', true);
  if (!data?.length) return ctx.reply('Нет активных промокодов');
  ctx.reply(data.map(p => `📌 ${p.code} | ${p.arc_amount} ARC | ${p.current_uses}/${p.max_uses}${p.expires_at ? ' | до ' + new Date(p.expires_at).toLocaleDateString('ru-RU') : ''}`).join('\n'));
});

// /addtask подписка|Название|канал|ARC|лимит|[дни]
// /addtask ссылка|Название|ссылка|ARC|лимит|[дни]
bot.command('addtask', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const parts = (ctx.match || '').trim().split('|');
  if (parts.length < 5) return ctx.reply('Формат:\n/addtask подписка|Название|канал|ARC|лимит|[дни]\n/addtask ссылка|Название|ссылка|ARC|лимит|[дни]\n\nЛимит 0 = без лимита, дни не указывать = бессрочно');
  let [type, title, target, arc, limit, days] = parts.map(s => s.trim());
  const isSub = (type === 'подписка' || type === 'subscribe');
  const expires = days ? new Date(Date.now() + parseInt(days) * 864e5).toISOString() : null;
  const { data, error } = await supabase.from('tasks').insert({
    title, task_type: isSub ? 'subscribe' : 'link',
    link: isSub ? '' : target,
    channel_username: isSub ? target.replace('@', '') : '',
    arc_reward: parseInt(arc), max_completions: parseInt(limit) || 0, current_completions: 0,
    active: true, expires_at: expires
  }).select().single();
  if (error) return ctx.reply('Ошибка: ' + error.message);
  ctx.reply(`✅ Задание #${data.id} | ${title} | ${arc} ARC | лимит ${parseInt(limit) || '∞'}${days ? ' | ' + days + 'дн' : ''}`);
});

bot.command('deltask', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const id = parseInt((ctx.match || '').trim());
  if (isNaN(id)) return ctx.reply('Формат: /deltask ID');
  await supabase.from('tasks').update({ active: false }).eq('id', id);
  ctx.reply(`🗑 Задание #${id} удалено`);
});

bot.command('listtasks', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const { data } = await supabase.from('tasks').select('*').eq('active', true);
  if (!data?.length) return ctx.reply('Нет активных заданий');
  ctx.reply(data.map(t => `📋 #${t.id} | ${t.title} | ${t.arc_reward} ARC | ${t.current_completions}/${t.max_completions || '∞'}`).join('\n'));
});

bot.command('stats', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const { data: users } = await supabase.from('users').select('arc_balance,ton_balance');
  const { data: pvp } = await supabase.from('pvp_rounds').select('id').order('id', { ascending: false }).limit(1);
  const totalArc = (users || []).reduce((s, u) => s + Number(u.arc_balance || 0), 0);
  const totalTon = (users || []).reduce((s, u) => s + Number(u.ton_balance || 0), 0);
  ctx.reply(`📊 BLACK\n👥 Юзеров: ${users?.length || 0}\n🪙 ARC: ${Math.floor(totalArc)}\n💎 TON: ${totalTon.toFixed(3)}\n⚔️ Раундов: ${pvp?.[0]?.id || 0}`);
});

// approve/reject вывода
bot.command('paid', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const id = parseInt((ctx.match || '').trim());
  if (isNaN(id)) return ctx.reply('Формат: /paid ID_транзакции');
  const { data: tx } = await supabase.from('transactions').select('*').eq('id', id).eq('type', 'withdraw').single();
  if (!tx) return ctx.reply('Заявка не найдена');
  await supabase.from('transactions').update({ status: 'completed' }).eq('id', id);
  bot.api.sendMessage(Number(tx.telegram_id), `✅ Вывод ${tx.amount} TON выполнен!`).catch(() => {});
  ctx.reply(`✅ Заявка #${id} отмечена выполненной`);
});

bot.command('reject', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const id = parseInt((ctx.match || '').trim());
  if (isNaN(id)) return ctx.reply('Формат: /reject ID_транзакции');
  const { data: tx } = await supabase.from('transactions').select('*').eq('id', id).eq('type', 'withdraw').eq('status', 'pending').single();
  if (!tx) return ctx.reply('Заявка не найдена');
  const { data: u } = await supabase.from('users').select('ton_balance').eq('telegram_id', tx.telegram_id).single();
  if (u) await supabase.from('users').update({ ton_balance: Number(u.ton_balance) + Number(tx.amount) }).eq('telegram_id', tx.telegram_id);
  await supabase.from('transactions').update({ status: 'rejected' }).eq('id', id);
  bot.api.sendMessage(Number(tx.telegram_id), `❌ Вывод ${tx.amount} TON отклонён. TON возвращены на баланс.`).catch(() => {});
  ctx.reply(`↩️ Заявка #${id} отклонена, TON возвращены`);
});

bot.command('openexchange', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await supabase.from('settings').upsert({ key: 'exchange_open', value: 'true' });
  ctx.reply('✅ Обмен открыт');
});
bot.command('closeexchange', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await supabase.from('settings').upsert({ key: 'exchange_open', value: 'false' });
  ctx.reply('🔒 Обмен закрыт');
});

// Ручной запуск проверки неактивности (для теста)
bot.command('decaynow', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await runInactivityDecay();
  ctx.reply('✅ Проверка неактивности выполнена');
});

// ---------- INACTIVITY DECAY ----------
// Считаем дни с последнего входа в Mini App.
// 5,6,7 день — предупреждение. 7 день — списываем -20%. 8+ день — -5%/день.
// Списываем пока юзер не зайдёт (last_app_open обновится) или баланс не станет 0.
function daysSince(ts) {
  if (!ts) return 0;
  const ms = Date.now() - new Date(ts).getTime();
  return Math.floor(ms / 86400000);
}

async function runInactivityDecay() {
  try {
    const today = moscowDate();
    const { data: users } = await supabase.from('users')
      .select('telegram_id,arc_balance,last_app_open,last_decay_date')
      .gt('arc_balance', 0);
    for (const u of users || []) {
      if (u.last_decay_date === today) continue; // уже обработан сегодня
      const days = daysSince(u.last_app_open);

      // Предупреждения на 5,6,7 день
      if (days === 5 || days === 6 || days === 7) {
        const left = 7 - days;
        const warn = left > 0
          ? `⚠️ *BLACK*\n\nYou haven't opened the app for ${days} days.\nIn ${left} day(s) you'll lose *20% of your ARC*!\n\n` +
            `⚠️ Ты не заходил ${days} дней.\nЧерез ${left} дн. спишется *20% ARC*!\n\nOpen the app to keep your coins 👇`
          : null;
        if (warn) bot.api.sendMessage(Number(u.telegram_id), warn, { parse_mode: 'Markdown' }).catch(() => {});
      }

      let penalty = 0, pct = 0;
      if (days === 7) pct = 0.20;        // ровно на 7-й день -20%
      else if (days >= 8) pct = 0.05;    // с 8-го дня -5% каждый день

      if (pct > 0) {
        const bal = Number(u.arc_balance);
        penalty = Math.ceil(bal * pct);
        const newBal = Math.max(0, bal - penalty);
        await supabase.from('users').update({ arc_balance: newBal, last_decay_date: today }).eq('telegram_id', u.telegram_id);
        await supabase.from('transactions').insert({
          telegram_id: u.telegram_id, type: 'decay', amount: -penalty, currency: 'ARC',
          description: `Inactivity -${Math.round(pct*100)}%`, created_at: nowISO()
        });
        const msg = `📉 *BLACK*\n\n-${penalty} ARC (-${Math.round(pct*100)}%) for inactivity.\nBalance: ${newBal} ARC\n\n` +
          `📉 Списано ${penalty} ARC (-${Math.round(pct*100)}%) за неактивность.\nБаланс: ${newBal} ARC\n\nOpen the app to stop losses 👇`;
        bot.api.sendMessage(Number(u.telegram_id), msg, { parse_mode: 'Markdown' }).catch(() => {});
      } else {
        // отметим обработку дня, чтобы не слать варнинг повторно
        await supabase.from('users').update({ last_decay_date: today }).eq('telegram_id', u.telegram_id);
      }
    }
  } catch (e) { console.error('decay error', e.message); }
}

// ---------- MIDNIGHT RESET (MSK) ----------
function scheduleMidnight() {
  const now = new Date();
  const msk = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  const next = new Date(msk); next.setHours(24, 0, 0, 0);
  setTimeout(async () => {
    await supabase.from('users').update({ exc_today: 0 }).neq('telegram_id', '');
    const today = moscowDate();
    await supabase.from('ad_views').delete().neq('view_date', today);
    await runInactivityDecay();   // штрафы за неактивность раз в сутки
    scheduleMidnight();
  }, next - msk);
}
scheduleMidnight();

// ---------- STATIC ----------
app.get('/tonconnect-manifest.json', (req, res) => res.json({ url: WEBAPP_URL, name: 'BLACK', iconUrl: WEBAPP_URL + '/icon.png' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 80;
app.listen(PORT, () => console.log(`BLACK running on ${PORT}`));
bot.start();
