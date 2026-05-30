'use strict';
const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { Bot } = require('grammy');
const path = require('path');
const WebSocket = require('ws');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const BOT_TOKEN = '7992348149:AAHDU8yhKGKU07TBLBRwFJ2HwWF5m6n_UKw';
const SUPABASE_URL = 'https://hzvwretfisjocxqtyqjf.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh6dndyZXRmaXNqb2N4cXR5cWpmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0ODQwMDMsImV4cCI6MjA5MzA2MDAwM30.M97Tgh-JxK-cgofzCqhvVv0K0fE5kfpUNGhn5-2Z8oI';
const ADMIN_ID = 5839503796;
const PLATFORM_WALLET = 'UQAG8cx9dXAWIfcoNUkdyki-Un9QzJxw3_xU8624H6OnZFMb';
const CHANNEL = 'blackt_channel';
const WEBAPP_URL = 'https://black-bot-azizjonkaroboev1.amvera.io';

const AD_SLOTS = {
  1: { name: 'Adsgram', arc: 5, max: 30, active: true },
  2: { name: 'Richads', arc: 5, max: 30, active: false },
  3: { name: 'Network 3', arc: 5, max: 30, active: false },
  4: { name: 'Network 4', arc: 5, max: 30, active: false },
  5: { name: 'Network 5', arc: 5, max: 30, active: false }
};

const bot = new Bot(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { realtime: { transport: WebSocket } });

// ===== HELPERS =====
function getMoscowDate() {
  return new Date().toLocaleString('en-CA', { timeZone: 'Europe/Moscow' }).split(',')[0];
}

// ===== AUTH =====
function verifyTelegramInitData(initData) {
  if (!initData) return false;
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');
  const checkString = [...params.entries()].sort().map(([k,v]) => `${k}=${v}`).join('\n');
  return crypto.createHmac('sha256', secret).update(checkString).digest('hex') === hash;
}

function authMiddleware(req, res, next) {
  const skip = ['/api/me', '/api/pvp/state', '/api/ton-rate', '/api/exchange/status', '/api/tasks'];
  if (skip.includes(req.path)) return next();
  const initData = req.headers['x-telegram-init-data'] || req.body?.initData;
  if (!initData) return res.status(401).json({ error: 'Missing initData' });
  if (!verifyTelegramInitData(initData)) return res.status(401).json({ error: 'Invalid initData' });
  const params = new URLSearchParams(initData);
  const userRaw = params.get('user');
  if (!userRaw) return res.status(401).json({ error: 'No user' });
  req.telegramUser = JSON.parse(userRaw);
  if (req.body?.telegram_id && String(req.body.telegram_id) !== String(req.telegramUser.id))
    return res.status(403).json({ error: 'ID mismatch' });
  next();
}
app.use(authMiddleware);

// ===== TON RATE =====
let tonRateUSD = 3.0;
async function fetchTonRate() {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd');
    const d = await r.json();
    tonRateUSD = d['the-open-network']?.usd || tonRateUSD;
  } catch(e) {}
}
fetchTonRate();
setInterval(fetchTonRate, 10*60*1000);

// ===== PVP =====
let currentRound = { id:1, status:'waiting', players:[], waitingTimer:null, countdownEndTime:null, winner:null, totalPool:0 };

function startWaitingTimer() {
  if (currentRound.waitingTimer) clearTimeout(currentRound.waitingTimer);
  if (currentRound.players.length !== 1) return;
  currentRound.waitingTimer = setTimeout(async () => {
    if (currentRound.players.length === 1 && currentRound.status === 'waiting') {
      const solo = currentRound.players[0];
      const { data: u } = await supabase.from('users').select('arc_balance').eq('telegram_id', solo.telegram_id).single();
      if (u) await supabase.from('users').update({ arc_balance: u.arc_balance + solo.bet }).eq('telegram_id', solo.telegram_id);
      currentRound = { id: currentRound.id+1, status:'waiting', players:[], waitingTimer:null, countdownEndTime:null, winner:null, totalPool:0 };
      bot.api.sendMessage(Number(solo.telegram_id), '⏰ Ставка возвращена — никто не пришёл за 60 секунд.').catch(()=>{});
    }
  }, 60000);
}

function startCountdown() {
  if (currentRound.status !== 'waiting') return;
  currentRound.status = 'countdown';
  currentRound.countdownEndTime = Date.now() + 15000;
  if (currentRound.waitingTimer) clearTimeout(currentRound.waitingTimer);
}

async function spinAndFinish() {
  if (currentRound.status !== 'countdown' || Date.now() < currentRound.countdownEndTime) return;
  currentRound.status = 'spinning';
  const total = currentRound.totalPool;
  if (!total || !currentRound.players.length) {
    currentRound = { id: currentRound.id+1, status:'waiting', players:[], waitingTimer:null, countdownEndTime:null, winner:null, totalPool:0 };
    return;
  }
  let rand = Math.random() * total, winner = null;
  for (const p of currentRound.players) { rand -= p.bet; if (rand <= 0) { winner = p; break; } }
  if (!winner) winner = currentRound.players[0];
  const fee = Math.floor(total * 0.10);
  const winAmount = total - fee;
  const { data: wu } = await supabase.from('users').select('arc_balance').eq('telegram_id', winner.telegram_id).single();
  await supabase.from('users').update({ arc_balance: (wu?.arc_balance||0) + winAmount }).eq('telegram_id', winner.telegram_id);
  await supabase.from('transactions').insert({ telegram_id: winner.telegram_id, type:'pvp_win', amount:winAmount, currency:'ARC', description:`PvP раунд #${currentRound.id}`, created_at: new Date().toISOString() });
  await supabase.from('pvp_rounds').insert({ round_id: currentRound.id, winner_id: winner.telegram_id, winner_name: winner.username, winner_amount: winAmount, total_pool: total, fee, players: currentRound.players.map(p=>({telegram_id:p.telegram_id,username:p.username,bet:p.bet})) });
  for (const p of currentRound.players) {
    const { data: pu } = await supabase.from('users').select('total_pvp_bet').eq('telegram_id', p.telegram_id).single();
    await supabase.from('users').update({ total_pvp_bet: (pu?.total_pvp_bet||0)+p.bet }).eq('telegram_id', p.telegram_id);
  }
  bot.api.sendMessage(Number(winner.telegram_id), `🏆 Вы выиграли PvP раунд #${currentRound.id}!\n💰 +${winAmount} ARC`).catch(()=>{});
  currentRound.winner = { telegram_id: winner.telegram_id, username: winner.username, amount: winAmount, chance: Number(((winner.bet/total)*100).toFixed(2)) };
  setTimeout(() => { currentRound = { id: currentRound.id+1, status:'waiting', players:[], waitingTimer:null, countdownEndTime:null, winner:null, totalPool:0 }; }, 4000);
}
setInterval(() => { if (currentRound.status==='countdown' && Date.now()>=currentRound.countdownEndTime) spinAndFinish(); }, 100);

// ===== MOSCOW MIDNIGHT RESET =====
function scheduleMidnightReset() {
  const now = new Date();
  const msk = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  const next = new Date(msk); next.setHours(24,0,0,0);
  setTimeout(async () => {
    await supabase.from('users').update({ exc_today:0, checkin_done:false });
    // Note: last_checkin_date stays - used to track streak
    const today = getMoscowDate();
    await supabase.from('ad_views').delete().neq('view_date', today);
    scheduleMidnightReset();
  }, next - msk);
}
scheduleMidnightReset();

// ===== ARC BURN =====
async function burnInactiveARC() {
  try {
    const sevenAgo = new Date(Date.now()-7*24*60*60*1000).toISOString();
    const { data: inactive } = await supabase.from('users').select('telegram_id,arc_balance,last_seen').lt('last_seen', sevenAgo).gt('arc_balance', 0);
    for (const u of inactive||[]) {
      const days = Math.floor((Date.now()-new Date(u.last_seen))/(24*60*60*1000));
      const pct = days===7 ? 0.20 : days>7 ? 0.05 : 0;
      if (pct > 0) {
        const burned = Math.floor(u.arc_balance*pct);
        if (burned>0) {
          await supabase.from('users').update({ arc_balance: u.arc_balance-burned }).eq('telegram_id', u.telegram_id);
          bot.api.sendMessage(Number(u.telegram_id), `🔥 Сожжено ${burned} ARC за неактивность ${days} дней.`).catch(()=>{});
        }
      }
    }
  } catch(e) {}
}
setInterval(burnInactiveARC, 60*60*1000);

// ===== API: ME =====
app.post('/api/me', async (req, res) => {
  try {
    const { initData } = req.body;
    if (!initData || !verifyTelegramInitData(initData)) return res.status(401).json({ error: 'Invalid' });
    const params = new URLSearchParams(initData);
    const user = JSON.parse(params.get('user'));
    const tgId = String(user.id);
    const startParam = params.get('start_param') || '';
    const { data: existing } = await supabase.from('users').select('*').eq('telegram_id', tgId).single();
    if (!existing) {
      await supabase.from('users').insert({ telegram_id:tgId, username:user.username||user.first_name||'User', first_name:user.first_name||'', photo_url:user.photo_url||'', ref_code:'ref_'+tgId, arc_balance:0, ton_balance:0, multiplier:1.0 });
      if (startParam.startsWith('ref_')) {
        const refId = startParam.slice(4);
        if (refId !== tgId) {
          const { data: ref } = await supabase.from('users').select('telegram_id').eq('telegram_id', refId).single();
          if (ref) {
            await supabase.from('referrals').insert({ referrer_id:refId, referred_id:tgId, earned_arc:0 });
            bot.api.sendMessage(Number(refId), `👥 Новый реферал: ${user.username||user.first_name}!`).catch(()=>{});
          }
        }
      }
    } else {
      await supabase.from('users').update({ last_seen:new Date().toISOString(), username:user.username||existing.username, photo_url:user.photo_url||existing.photo_url }).eq('telegram_id', tgId);
    }
    res.json({ id:user.id, username:user.username||'', first_name:user.first_name||'', photo_url:user.photo_url||'' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== API: USER =====
app.get('/api/user/:tgId', async (req, res) => {
  try {
    const { tgId } = req.params;
    const { data } = await supabase.from('users').select('*').eq('telegram_id', tgId).single();
    if (!data) return res.json({ arc_balance:0, ton_balance:0, multiplier:1.0 });
    const { data: refs } = await supabase.from('referrals').select('referred_id,earned_arc').eq('referrer_id', tgId);
    const { data: txs } = await supabase.from('transactions').select('*').eq('telegram_id', tgId).order('created_at',{ascending:false}).limit(50);
    const today = getMoscowDate();
    const { data: adRows } = await supabase.from('ad_views').select('ad_slot,views_count').eq('telegram_id', tgId).eq('view_date', today);
    const ads_today = {1:0,2:0,3:0,4:0,5:0};
    (adRows||[]).forEach(v => { ads_today[v.ad_slot]=v.views_count; });
    // Compute checkin_done from last_checkin_date — don't trust DB flag (server restarts lose the midnight reset)
    const checkin_done = data.last_checkin_date === today;
    res.json({ ...data, checkin_done, friends:refs||[], transactions:txs||[], ads_today });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== API: AD VIEW =====
app.post('/api/ad/view', async (req, res) => {
  try {
    const { telegram_id, ad_slot } = req.body;
    const slot = parseInt(ad_slot)||1;
    const cfg = AD_SLOTS[slot];
    if (!cfg?.active) return res.status(400).json({ error: 'Реклама недоступна' });
    const today = getMoscowDate();
    const { data: existing } = await supabase.from('ad_views').select('*').eq('telegram_id', String(telegram_id)).eq('ad_slot', slot).eq('view_date', today).single();
    const views = existing?.views_count||0;
    if (views >= cfg.max) return res.status(400).json({ error: 'Дневной лимит исчерпан', views, max: cfg.max });
    if (existing) await supabase.from('ad_views').update({ views_count: views+1 }).eq('id', existing.id);
    else await supabase.from('ad_views').insert({ telegram_id:String(telegram_id), ad_slot:slot, view_date:today, views_count:1 });
    const { data: user } = await supabase.from('users').select('arc_balance,multiplier').eq('telegram_id', String(telegram_id)).single();
    const mult = user?.multiplier||1.0;
    const arcEarned = Math.floor(cfg.arc*mult);
    await supabase.from('users').update({ arc_balance:(user?.arc_balance||0)+arcEarned }).eq('telegram_id', String(telegram_id));
    await supabase.from('transactions').insert({ telegram_id:String(telegram_id), type:'ad_reward', amount:arcEarned, currency:'ARC', description:`Реклама ${slot}: +${arcEarned} ARC`, created_at:new Date().toISOString() });
    // Referral bonuses
    const { data: ref1 } = await supabase.from('referrals').select('referrer_id,earned_arc').eq('referred_id', String(telegram_id)).single();
    if (ref1) {
      const b1 = Math.floor(arcEarned*0.20);
      if (b1>0) {
        const { data: r1 } = await supabase.from('users').select('arc_balance').eq('telegram_id', ref1.referrer_id).single();
        if (r1) await supabase.from('users').update({ arc_balance: r1.arc_balance+b1 }).eq('telegram_id', ref1.referrer_id);
        await supabase.from('referrals').update({ earned_arc:(ref1.earned_arc||0)+b1 }).eq('referred_id', String(telegram_id)).eq('referrer_id', ref1.referrer_id);
        const { data: ref2 } = await supabase.from('referrals').select('referrer_id').eq('referred_id', ref1.referrer_id).single();
        if (ref2) {
          const b2 = Math.floor(arcEarned*0.05);
          if (b2>0) {
            const { data: r2 } = await supabase.from('users').select('arc_balance').eq('telegram_id', ref2.referrer_id).single();
            if (r2) await supabase.from('users').update({ arc_balance: r2.arc_balance+b2 }).eq('telegram_id', ref2.referrer_id);
          }
        }
      }
    }
    res.json({ ok:true, arc_earned:arcEarned, views:views+1, max:cfg.max });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== API: PROMO =====
app.post('/api/promo/use', async (req, res) => {
  try {
    const { telegram_id, code } = req.body;
    const c = (code||'').toUpperCase().trim();
    const { data: promo } = await supabase.from('promos').select('*').eq('code', c).eq('active', true).single();
    if (!promo) return res.status(400).json({ error: 'Промокод не найден' });
    if (promo.current_uses >= promo.max_uses) return res.status(400).json({ error: 'Лимит промокода исчерпан' });
    const { data: used } = await supabase.from('promo_uses').select('id').eq('promo_code', c).eq('telegram_id', String(telegram_id)).single();
    if (used) return res.status(400).json({ error: 'Вы уже использовали этот промокод' });
    const { data: user } = await supabase.from('users').select('arc_balance').eq('telegram_id', String(telegram_id)).single();
    if (!user) return res.status(400).json({ error: 'Пользователь не найден' });
    await supabase.from('users').update({ arc_balance: user.arc_balance+promo.arc_amount }).eq('telegram_id', String(telegram_id));
    await supabase.from('promo_uses').insert({ promo_code:c, telegram_id:String(telegram_id) });
    await supabase.from('promos').update({ current_uses: promo.current_uses+1 }).eq('code', c);
    await supabase.from('transactions').insert({ telegram_id:String(telegram_id), type:'promo', amount:promo.arc_amount, currency:'ARC', description:`Промокод ${c}`, created_at:new Date().toISOString() });
    res.json({ ok:true, arc_amount:promo.arc_amount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== API: TASKS =====
app.get('/api/tasks', async (req, res) => {
  try {
    const { data } = await supabase.from('tasks').select('*').eq('active', true).order('created_at',{ascending:false});
    res.json(data||[]);
  } catch(e) { res.json([]); }
});

app.post('/api/task/complete', async (req, res) => {
  try {
    const { telegram_id, task_id } = req.body;
    const { data: task } = await supabase.from('tasks').select('*').eq('id', task_id).eq('active', true).single();
    if (!task) return res.status(400).json({ error: 'Задание не найдено' });
    if (task.max_completions>0 && task.current_completions>=task.max_completions) return res.status(400).json({ error: 'Лимит исчерпан' });
    const { data: done } = await supabase.from('task_completions').select('id').eq('task_id', task_id).eq('telegram_id', String(telegram_id)).single();
    if (done) return res.status(400).json({ error: 'Задание уже выполнено' });
    if (task.task_type==='subscribe' && task.channel_username) {
      try {
        const member = await bot.api.getChatMember('@'+task.channel_username.replace('@',''), Number(telegram_id));
        if (!['member','administrator','creator'].includes(member.status)) return res.status(400).json({ error: 'Вы не подписаны на канал' });
      } catch(e) { return res.status(400).json({ error: 'Не удалось проверить подписку' }); }
    }
    const { data: user } = await supabase.from('users').select('arc_balance').eq('telegram_id', String(telegram_id)).single();
    if (!user) return res.status(400).json({ error: 'Не найден' });
    await supabase.from('users').update({ arc_balance: user.arc_balance+task.arc_reward }).eq('telegram_id', String(telegram_id));
    await supabase.from('task_completions').insert({ task_id, telegram_id:String(telegram_id) });
    await supabase.from('tasks').update({ current_completions: task.current_completions+1 }).eq('id', task_id);
    await supabase.from('transactions').insert({ telegram_id:String(telegram_id), type:'task', amount:task.arc_reward, currency:'ARC', description:`Задание: ${task.title}`, created_at:new Date().toISOString() });
    res.json({ ok:true, arc_reward:task.arc_reward });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== API: CHECKIN =====
app.post('/api/checkin', async (req, res) => {
  try {
    const { telegram_id } = req.body;
    const { data: user } = await supabase.from('users').select('*').eq('telegram_id', String(telegram_id)).single();
    if (!user) return res.status(400).json({ error: 'Not found' });
    const todayMSK = getMoscowDate();
    // Already checked in today
    if (user.last_checkin_date === todayMSK) return res.status(400).json({ error: 'already_done' });
    // Check if streak continues or resets
    const yd = new Date(); yd.setDate(yd.getDate() - 1);
    const yesterdayMSK = yd.toLocaleString('en-CA', { timeZone: 'Europe/Moscow' }).split(',')[0];
    let currentDay = user.checkin_day || 1;
    // If last checkin was NOT yesterday, reset streak
    if (user.last_checkin_date && user.last_checkin_date !== yesterdayMSK) {
      currentDay = 1;
    }
    const multiplier = Math.min(1.0 + (currentDay - 1) * 0.1, 1.5);
    const nextDay = currentDay >= 6 ? 1 : currentDay + 1;
    await supabase.from('users').update({
      checkin_done: true,
      checkin_day: nextDay,
      multiplier: multiplier,
      last_checkin_date: todayMSK
    }).eq('telegram_id', String(telegram_id));
    res.json({ ok: true, day: currentDay, multiplier });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== API: PVP =====
app.get('/api/pvp/state', (req, res) => {
  const countdown = currentRound.status==='countdown' ? Math.max(0, Math.ceil((currentRound.countdownEndTime-Date.now())/1000)) : null;
  res.json({ roundId:currentRound.id, status:currentRound.status, players:currentRound.players.map(p=>({ telegram_id:p.telegram_id, username:p.username, bet:p.bet, chance:Number(((p.bet/Math.max(currentRound.totalPool,1))*100).toFixed(2)) })), totalPool:currentRound.totalPool, countdown, winner:currentRound.winner });
});

app.post('/api/pvp/join', async (req, res) => {
  try {
    const { telegram_id, bet } = req.body;
    const amt = parseInt(bet);
    if (amt<10) return res.status(400).json({ error:'Минимум 10 ARC' });
    if (amt>5000) return res.status(400).json({ error:'Максимум 5000 ARC' });
    if (currentRound.status==='spinning') return res.status(400).json({ error:'Раунд идёт' });
    const { data: user } = await supabase.from('users').select('arc_balance,username').eq('telegram_id', String(telegram_id)).single();
    if (!user||user.arc_balance<amt) return res.status(400).json({ error:'Недостаточно ARC' });
    const existing = currentRound.players.find(p=>p.telegram_id===String(telegram_id));
    if (!existing && currentRound.players.length>=10) return res.status(400).json({ error:'Максимум 10 игроков' });
    await supabase.from('users').update({ arc_balance:user.arc_balance-amt }).eq('telegram_id', String(telegram_id));
    if (existing) { existing.bet+=amt; }
    else { currentRound.players.push({ telegram_id:String(telegram_id), username:user.username, bet:amt }); }
    currentRound.totalPool+=amt;
    if (currentRound.players.length===1) startWaitingTimer();
    if (currentRound.players.length===2 && currentRound.status==='waiting') startCountdown();
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pvp/history', async (req, res) => {
  try {
    const { data } = await supabase.from('pvp_rounds').select('*').order('created_at',{ascending:false}).limit(20);
    res.json(data||[]);
  } catch(e) { res.json([]); }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const type = req.query.type||'pvp';
    const myId = req.query.tg_id||'';
    if (type==='pvp') {
      const { data } = await supabase.from('users').select('telegram_id,username,total_pvp_bet').order('total_pvp_bet',{ascending:false}).limit(200);
      const all = (data||[]).map((u,i)=>({ rank:i+1, name:u.username, val:u.total_pvp_bet||0, init:(u.username||'U')[0].toUpperCase(), tid:u.telegram_id }));
      const top = all.slice(0,50);
      const me = myId ? all.find(u=>String(u.tid)===String(myId)) : null;
      return res.json({ top, me: me||null });
    }
    const { data } = await supabase.from('ad_views').select('telegram_id,views_count');
    const map = {};
    (data||[]).forEach(v=>{ map[v.telegram_id]=(map[v.telegram_id]||0)+v.views_count; });
    const sorted = Object.entries(map).sort((a,b)=>b[1]-a[1]);
    const result = [];
    for (const [tid,val] of sorted) {
      const { data: u } = await supabase.from('users').select('username').eq('telegram_id', tid).single();
      result.push({ tid, name:u?.username||tid, val, init:(u?.username||'U')[0].toUpperCase() });
    }
    const withRank = result.map((u,i)=>({...u,rank:i+1}));
    const top = withRank.slice(0,50);
    const me = myId ? withRank.find(u=>String(u.tid)===String(myId)) : null;
    res.json({ top, me: me||null });
  } catch(e) { res.json({ top:[], me:null }); }
});

// ===== API: EXCHANGE =====
app.get('/api/exchange/status', async (req, res) => {
  try {
    const { data: s } = await supabase.from('settings').select('value').eq('key','exchange_open').single();
    const { data: p } = await supabase.from('settings').select('value').eq('key','exchange_pool_usd').single();
    const open = s?.value==='true';
    const poolUsd = parseFloat(p?.value||'0');
    const { data: users } = await supabase.from('users').select('arc_balance');
    const totalArc = (users||[]).reduce((s,u)=>s+(u.arc_balance||0),0);
    const rate = totalArc>0&&poolUsd>0 ? poolUsd/totalArc : 0;
    res.json({ open, pool_usd:poolUsd, total_arc:totalArc, rate_usd_per_arc:rate, ton_rate:tonRateUSD });
  } catch(e) { res.json({ open:false, pool_usd:0, total_arc:0, rate_usd_per_arc:0 }); }
});

app.post('/api/exchange/arc-to-ton', async (req, res) => {
  try {
    const { telegram_id, arc_amount } = req.body;
    const { data: s } = await supabase.from('settings').select('value').eq('key','exchange_open').single();
    if (s?.value!=='true') return res.status(400).json({ error:'Обмен закрыт' });
    const { data: p } = await supabase.from('settings').select('value').eq('key','exchange_pool_usd').single();
    const poolUsd = parseFloat(p?.value||'0');
    const { data: users } = await supabase.from('users').select('arc_balance');
    const totalArc = (users||[]).reduce((s,u)=>s+(u.arc_balance||0),0);
    if (!totalArc||!poolUsd) return res.status(400).json({ error:'Курс недоступен' });
    const usdVal = arc_amount*(poolUsd/totalArc);
    const tonVal = usdVal/tonRateUSD;
    const { data: user } = await supabase.from('users').select('arc_balance,ton_balance').eq('telegram_id', String(telegram_id)).single();
    if (!user||user.arc_balance<arc_amount) return res.status(400).json({ error:'Недостаточно ARC' });
    await supabase.from('users').update({ arc_balance:user.arc_balance-arc_amount, ton_balance:user.ton_balance+tonVal }).eq('telegram_id', String(telegram_id));
    await supabase.from('transactions').insert({ telegram_id:String(telegram_id), type:'exchange_arc_ton', amount:arc_amount, currency:'ARC', description:`Обмен ${arc_amount} ARC → ${tonVal.toFixed(4)} TON`, created_at:new Date().toISOString() });
    await supabase.from('settings').update({ value:String(Math.max(0,poolUsd-usdVal)) }).eq('key','exchange_pool_usd');
    res.json({ ok:true, ton_received:tonVal });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/exchange', async (req, res) => {
  try {
    const { telegram_id, ton_amount } = req.body;
    const tonAmt = parseFloat(ton_amount);
    if (tonAmt<=0) return res.status(400).json({ error:'Invalid' });
    const { data: user } = await supabase.from('users').select('ton_balance,arc_balance,exc_today').eq('telegram_id', String(telegram_id)).single();
    if (!user||user.ton_balance<tonAmt) return res.status(400).json({ error:'Insufficient TON' });
    if ((user.exc_today||0)+tonAmt>5) return res.status(400).json({ error:'Daily limit 5 TON' });
    const arcAmount = Math.floor(tonAmt*(tonRateUSD/0.0003));
    await supabase.from('users').update({ ton_balance:user.ton_balance-tonAmt, arc_balance:(user.arc_balance||0)+arcAmount, exc_today:(user.exc_today||0)+tonAmt }).eq('telegram_id', String(telegram_id));
    await supabase.from('transactions').insert({ telegram_id:String(telegram_id), type:'exchange', amount:arcAmount, currency:'ARC', description:`Обмен ${tonAmt} TON → ${arcAmount} ARC`, created_at:new Date().toISOString() });
    res.json({ ok:true, arc_credited:arcAmount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== API: DEPOSIT/WITHDRAW =====
app.post('/api/check-deposit', async (req, res) => {
  try {
    const { telegram_id, expected_ton } = req.body;
    const { data } = await supabase.from('transactions').select('amount').eq('telegram_id', String(telegram_id)).eq('type','deposit').eq('currency','TON').order('created_at',{ascending:false}).limit(1).single();
    if (!data) return res.json({ confirmed:false });
    res.json({ confirmed: expected_ton ? Number(data.amount)>=Number(expected_ton)-0.000001 : true, amount:data.amount });
  } catch(e) { res.json({ confirmed:false }); }
});

async function monitorDeposits() {
  try {
    const r = await fetch(`https://toncenter.com/api/v2/getTransactions?address=${PLATFORM_WALLET}&limit=20`);
    const data = await r.json();
    for (const tx of data.result||[]) {
      const txHash = tx.transaction_id?.hash;
      if (!txHash) continue;
      const { data: ex } = await supabase.from('transactions').select('id').eq('tx_hash', txHash).single();
      if (ex) continue;
      const msg = tx.in_msg||{};
      let comment = msg.message||msg.msg_data?.text||'';
      try {
        const buf = Buffer.from(comment,'base64');
        const dec = buf.readUInt32BE(0)===0 ? buf.subarray(4).toString('utf8') : buf.toString('utf8');
        if (dec.includes('black_dep_')) comment=dec;
      } catch(e) {}
      const match = comment.match(/black_dep_(\d+)/);
      if (match) {
        const uid = match[1];
        const amt = Number(msg.value)/1e9;
        if (amt>=0.1) {
          const { data: user } = await supabase.from('users').select('ton_balance').eq('telegram_id', uid).single();
          if (user) {
            await supabase.from('users').update({ ton_balance:(user.ton_balance||0)+amt }).eq('telegram_id', uid);
            await supabase.from('transactions').insert({ telegram_id:uid, type:'deposit', amount:amt, currency:'TON', tx_hash:txHash, description:`Депозит ${amt.toFixed(3)} TON`, created_at:new Date().toISOString() });
            bot.api.sendMessage(Number(uid), `✅ Депозит зачислен: +${amt.toFixed(3)} TON`).catch(()=>{});
            bot.api.sendMessage(ADMIN_ID, `💰 Депозит!\n👤 ID: ${uid}\n💎 ${amt.toFixed(3)} TON\n🔗 ${txHash}`).catch(()=>{});
          }
        }
      }
    }
  } catch(e) {}
  }
setInterval(monitorDeposits, 5000);
monitorDeposits();

app.post('/api/withdraw-request', async (req, res) => {
  try {
    const { telegram_id, ton_amount, wallet, username } = req.body;
    const amt = Number(ton_amount);
    if (amt<0.1) return res.status(400).json({ error:'Минимум 0.1 TON' });
    const { data: user } = await supabase.from('users').select('ton_balance').eq('telegram_id', String(telegram_id)).single();
    if (!user||user.ton_balance<amt) return res.status(400).json({ error:'Insufficient TON' });
    await supabase.from('users').update({ ton_balance:user.ton_balance-amt }).eq('telegram_id', String(telegram_id));
    await supabase.from('transactions').insert({ telegram_id:String(telegram_id), type:'withdraw', amount:amt, currency:'TON', status:'pending', wallet_addr:wallet, description:`Вывод ${amt} TON`, created_at:new Date().toISOString() });
    bot.api.sendMessage(ADMIN_ID, `⬆️ Заявка на вывод!\n👤 ${username||telegram_id}\n🆔 ${telegram_id}\n💎 ${amt} TON\n👛 ${wallet}`).catch(()=>{});
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/withdraw-cancel', async (req, res) => {
  try {
    const { transaction_id, telegram_id } = req.body;
    const { data: tx } = await supabase.from('transactions').select('status,amount').eq('id', transaction_id).eq('telegram_id', String(telegram_id)).single();
    if (!tx||tx.status!=='pending') return res.status(400).json({ error:'Not found' });
    const { data: user } = await supabase.from('users').select('ton_balance').eq('telegram_id', String(telegram_id)).single();
    if (user) await supabase.from('users').update({ ton_balance:user.ton_balance+tx.amount }).eq('telegram_id', String(telegram_id));
    await supabase.from('transactions').update({ status:'cancelled' }).eq('id', transaction_id);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/wallet/connect', async (req, res) => {
  try {
    await supabase.from('users').update({ wallet_addr:req.body.wallet_addr }).eq('telegram_id', String(req.body.telegram_id));
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/wallet/disconnect', async (req, res) => {
  try {
    await supabase.from('users').update({ wallet_addr:'' }).eq('telegram_id', String(req.body.telegram_id));
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== API: MISC =====
app.get('/api/task-completions/:tgId', async (req, res) => {
  try {
    const { data } = await supabase.from('task_completions').select('task_id').eq('telegram_id', req.params.tgId);
    res.json({ data: data||[] });
  } catch(e) { res.json({ data:[] }); }
});

app.get('/api/ton-rate', (req, res) => res.json({ rate:tonRateUSD, arc_per_ton:Math.floor(tonRateUSD/0.0003) }));

app.post('/api/check-subscription', async (req, res) => {
  try {
    const { telegram_id, channel } = req.body;
    const member = await bot.api.getChatMember(`@${channel}`, Number(telegram_id));
    res.json({ subscribed:['member','administrator','creator'].includes(member.status) });
  } catch(e) { res.json({ subscribed:false }); }
});

// ===== BOT =====
bot.command('start', async (ctx) => {
  const userId = String(ctx.from.id);
  const startParam = ctx.match||'';
  const { data: existing } = await supabase.from('users').select('telegram_id').eq('telegram_id', userId).single();
  if (!existing) {
    await supabase.from('users').insert({ telegram_id:userId, username:ctx.from.username||ctx.from.first_name||'User', first_name:ctx.from.first_name||'', ref_code:'ref_'+userId, arc_balance:0, ton_balance:0, multiplier:1.0 });
    if (startParam.startsWith('ref_')) {
      const refId = startParam.slice(4);
      if (refId!==userId) {
        const { data: ref } = await supabase.from('users').select('telegram_id').eq('telegram_id', refId).single();
        if (ref) {
          await supabase.from('referrals').insert({ referrer_id:refId, referred_id:userId, earned_arc:0 });
          bot.api.sendMessage(Number(refId), `👥 Новый реферал: ${ctx.from.username||ctx.from.first_name}!`).catch(()=>{});
        }
      }
    }
  }
  await ctx.reply('🖤 Добро пожаловать в Platform BLACK!\n\nЗарабатывай ARC — получай TON', {
    reply_markup: { inline_keyboard: [
      [{ text:'🚀 Открыть BLACK', web_app:{ url:WEBAPP_URL } }],
      [{ text:'📢 Канал', url:'https://t.me/'+CHANNEL }, { text:'💬 Поддержка', url:'https://t.me/Ventlp' }]
    ]}
  });
});

const isAdmin = ctx => ctx.from?.id === ADMIN_ID;

// /addpromo CODE ARC LIMIT  →  /addpromo BLACK100 100 500
bot.command('addpromo', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const [code, arcStr, limitStr] = (ctx.match||'').trim().split(/\s+/);
  if (!code||!arcStr||!limitStr) return ctx.reply('Формат: /addpromo КОД ARC ЛИМИТ\nПример: /addpromo BLACK100 100 500');
  const { error } = await supabase.from('promos').insert({ code:code.toUpperCase(), arc_amount:parseInt(arcStr), max_uses:parseInt(limitStr), current_uses:0, active:true });
  if (error) return ctx.reply('Ошибка: ' + error.message);
  ctx.reply(`✅ Промокод создан!\nКод: ${code.toUpperCase()}\nARC: ${arcStr}\nЛимит: ${limitStr}`);
});

bot.command('delpromo', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const code = (ctx.match||'').trim().toUpperCase();
  await supabase.from('promos').update({ active:false }).eq('code', code);
  ctx.reply(`🗑 Промокод ${code} деактивирован`);
});

bot.command('listpromos', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const { data } = await supabase.from('promos').select('*').eq('active', true);
  if (!data?.length) return ctx.reply('Нет активных промокодов');
  ctx.reply('Активные промокоды:\n\n' + data.map(p=>`📌 ${p.code} | ${p.arc_amount} ARC | ${p.current_uses}/${p.max_uses}`).join('\n'));
});

// /addtask subscribe|Название|канал|ARC|лимит
// /addtask link|Название|https://...|ARC|лимит  (лимит 0 = без лимита)
bot.command('addtask', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const parts = (ctx.match||'').trim().split('|');
  if (parts.length<5) return ctx.reply('Формат:\n/addtask subscribe|Название|канал|ARC|лимит\n/addtask link|Название|ссылка|ARC|лимит\n\nЛимит 0 = без лимита');
  const [type, title, linkOrCh, arcStr, limitStr] = parts;
  const { data, error } = await supabase.from('tasks').insert({ title:title.trim(), link:type==='link'?linkOrCh.trim():'', arc_reward:parseInt(arcStr), max_completions:parseInt(limitStr)||0, current_completions:0, task_type:type.trim(), channel_username:type==='subscribe'?linkOrCh.trim().replace('@',''):'', active:true }).select().single();
  if (error) return ctx.reply('Ошибка: ' + error.message);
  ctx.reply(`✅ Задание создано!\nID: ${data.id}\nТип: ${type}\nНазвание: ${title}\nARC: ${arcStr}\nЛимит: ${parseInt(limitStr)||'∞'}`);
});

bot.command('deltask', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const id = parseInt((ctx.match||'').trim());
  if (isNaN(id)) return ctx.reply('Формат: /deltask ID');
  await supabase.from('tasks').update({ active:false }).eq('id', id);
  ctx.reply(`🗑 Задание #${id} деактивировано`);
});

bot.command('listtasks', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const { data } = await supabase.from('tasks').select('*').eq('active', true);
  if (!data?.length) return ctx.reply('Нет активных заданий');
  ctx.reply('Активные задания:\n\n' + data.map(t=>`📋 #${t.id} | ${t.title} | ${t.arc_reward} ARC | ${t.current_completions}/${t.max_completions||'∞'}`).join('\n'));
});

// /openexchange 300  (300 = пул в $)
bot.command('openexchange', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const poolUsd = parseFloat((ctx.match||'').trim())||0;
  await supabase.from('settings').upsert({ key:'exchange_open', value:'true' });
  if (poolUsd>0) await supabase.from('settings').upsert({ key:'exchange_pool_usd', value:String(poolUsd) });
  ctx.reply(`✅ Обмен ARC→TON открыт!\nПул: ${poolUsd}$`);
});

bot.command('closeexchange', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await supabase.from('settings').upsert({ key:'exchange_open', value:'false' });
  ctx.reply('🔒 Обмен ARC→TON закрыт');
});

bot.command('stats', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const { data: users } = await supabase.from('users').select('arc_balance,ton_balance');
  const { data: pvp } = await supabase.from('pvp_rounds').select('id').order('id',{ascending:false}).limit(1);
  const totalArc = (users||[]).reduce((s,u)=>s+(u.arc_balance||0),0);
  const totalTon = (users||[]).reduce((s,u)=>s+(u.ton_balance||0),0);
  ctx.reply(`📊 Статистика BLACK\n\n👥 Пользователей: ${users?.length||0}\n🪙 ARC в обороте: ${Math.floor(totalArc)}\n💎 TON на балансах: ${totalTon.toFixed(3)}\n⚔️ Раундов PvP: ${pvp?.[0]?.id||0}`);
});

app.get('/tonconnect-manifest.json', (req, res) => res.json({ url:WEBAPP_URL, name:'Platform BLACK', iconUrl:WEBAPP_URL+'/icon.png' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT||80;
app.listen(PORT, () => console.log(`BLACK running on port ${PORT}`));
bot.start();
