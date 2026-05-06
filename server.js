const express = require('express');
const crypto = require('crypto');
const ws = require('ws');
const { createClient } = require('@supabase/supabase-js');
const { Bot } = require('grammy');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ADMIN_ID = 5839503796;
const PLATFORM_WALLET = 'UQAG8cx9dXAWIfcoNUkdyki-Un9QzJxw3_xU8624H6OnZFMb';
const CHANNEL = 'blackt_channel';

const bot = new Bot(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: { transport: ws }
});

function authMiddleware(req, res, next) {
  return next();
}

let tonRate = 1.33;
async function fetchTonRate() {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd');
    const d = await r.json();
    tonRate = d['the-open-network']?.usd || tonRate;
  } catch (e) {}
}
fetchTonRate();
setInterval(fetchTonRate, 10 * 60 * 1000);

function getArcPerTon() {
  return 3500;
}

app.get('/api/user/:tgId', authMiddleware, async (req, res) => {
  try {
    const { tgId } = req.params;
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('telegram_id', tgId)
      .single();
    if (error || !data) return res.json({ arc_balance: 0, ton_balance: 0, multiplier: 1.0 });
    const { data: refs } = await supabase
      .from('referrals')
      .select('referred_id, earned_arc')
      .eq('referrer_id', tgId);
    const { data: txs } = await supabase
      .from('transactions')
      .select('*')
      .eq('telegram_id', tgId)
      .order('created_at', { ascending: false })
      .limit(50);
    return res.json({ ...data, friends: refs || [], transactions: txs || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/user/save', authMiddleware, async (req, res) => {
  try {
    const { telegram_id, arc_balance, ton_balance, multiplier, checkin_day,
      checkin_done, exc_today, done_tasks, wallet_addr } = req.body;
    if (!telegram_id) return res.status(400).json({ error: 'No telegram_id' });
    const { error } = await supabase.from('users').update({
      arc_balance: arc_balance ?? 0,
      ton_balance: ton_balance ?? 0,
      multiplier: multiplier ?? 1.0,
      checkin_day: checkin_day ?? 1,
      checkin_done: checkin_done ?? false,
      exc_today: exc_today ?? 0,
      done_tasks: done_tasks ?? [],
      wallet_addr: wallet_addr ?? '',
      last_seen: new Date().toISOString(),
    }).eq('telegram_id', String(telegram_id));
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/user/register', async (req, res) => {
  try {
    const { telegram_id, username, first_name, photo_url, ref_code } = req.body;
    if (!telegram_id) return res.status(400).json({ error: 'No telegram_id' });
    const { data: existing } = await supabase
      .from('users')
      .select('telegram_id')
      .eq('telegram_id', String(telegram_id))
      .single();
    if (!existing) {
      await supabase.from('users').insert({
        telegram_id: String(telegram_id),
        username: username || '',
        first_name: first_name || '',
        photo_url: photo_url || '',
        arc_balance: 0,
        ton_balance: 0,
        multiplier: 1.0,
        checkin_day: 1,
        checkin_done: false,
        exc_today: 0,
        done_tasks: [],
        wallet_addr: '',
        ref_code: String(telegram_id),
        created_at: new Date().toISOString(),
        last_seen: new Date().toISOString(),
      });
      if (ref_code && ref_code !== String(telegram_id)) {
        const { data: referrer } = await supabase
          .from('users')
          .select('telegram_id')
          .eq('ref_code', ref_code)
          .single();
        if (referrer) {
          await supabase.from('referrals').insert({
            referrer_id: referrer.telegram_id,
            referred_id: String(telegram_id),
            earned_arc: 0,
          });
        }
      }
    } else {
      await supabase.from('users').update({
        last_seen: new Date().toISOString(),
        username: username || '',
        first_name: first_name || '',
      }).eq('telegram_id', String(telegram_id));
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/check-subscription', authMiddleware, async (req, res) => {
  try {
    const { telegram_id, channel } = req.body;
    const member = await bot.api.getChatMember(`@${channel}`, Number(telegram_id));
    const subscribed = ['member', 'administrator', 'creator'].includes(member.status);
    res.json({ subscribed });
  } catch (e) {
    res.json({ subscribed: false });
  }
});

app.post('/api/exchange', authMiddleware, async (req, res) => {
  try {
    const { telegram_id, ton_amount } = req.body;
    if (!telegram_id || !ton_amount) return res.status(400).json({ error: 'Missing fields' });
    const { data: user } = await supabase
      .from('users')
      .select('ton_balance, arc_balance, exc_today')
      .eq('telegram_id', String(telegram_id))
      .single();
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.ton_balance < ton_amount) return res.status(400).json({ error: 'Insufficient TON' });
    const today_used = user.exc_today || 0;
    if (today_used + ton_amount > 5) return res.status(400).json({ error: 'Daily limit reached' });
    const arc_amount = Math.floor(ton_amount * getArcPerTon());
    await supabase.from('users').update({
      ton_balance: user.ton_balance - ton_amount,
      arc_balance: user.arc_balance + arc_amount,
      exc_today: today_used + ton_amount,
    }).eq('telegram_id', String(telegram_id));
    await supabase.from('transactions').insert({
      telegram_id: String(telegram_id),
      type: 'exchange',
      amount: arc_amount,
      currency: 'ARC',
      description: `Обмен ${ton_amount} TON → ${arc_amount} ARC`,
      created_at: new Date().toISOString(),
    });
    res.json({ ok: true, arc_credited: arc_amount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/check-deposit', authMiddleware, async (req, res) => {
  try {
    const { telegram_id, expected_ton } = req.body;
    const response = await fetch(
      `https://tonapi.io/v2/accounts/${PLATFORM_WALLET}/transactions?limit=10`
    );
    const data = await response.json();
    if (!data.transactions) return res.json({ confirmed: false });
    const nowSec = Math.floor(Date.now() / 1000);
    const nanoAmount = Math.floor(expected_ton * 1e9);
    const found = data.transactions.find(tx => {
      const isRecent = (nowSec - tx.utime) < 600;
      const amountMatch = Math.abs(tx.in_msg?.value - nanoAmount) < 1e7;
      return isRecent && amountMatch && tx.in_msg?.value > 0;
    });
    if (found) {
      const { data: existing } = await supabase
        .from('transactions')
        .select('id')
        .eq('tx_hash', found.hash)
        .single();
      if (existing) return res.json({ confirmed: false, already_processed: true });
      const { data: user } = await supabase
        .from('users')
        .select('ton_balance')
        .eq('telegram_id', String(telegram_id))
        .single();
      const newBalance = (user?.ton_balance || 0) + expected_ton;
      await supabase.from('users').update({
        ton_balance: newBalance,
      }).eq('telegram_id', String(telegram_id));
      await supabase.from('transactions').insert({
        telegram_id: String(telegram_id),
        type: 'deposit',
        amount: expected_ton,
        currency: 'TON',
        tx_hash: found.hash,
        description: `Депозит ${expected_ton} TON`,
        created_at: new Date().toISOString(),
      });
      await bot.api.sendMessage(ADMIN_ID,
        `💰 Депозит!\n👤 ID: ${telegram_id}\n💎 ${expected_ton} TON\n💰 Баланс: ${newBalance.toFixed(3)} TON`
      );
      return res.json({ confirmed: true, ton_credited: expected_ton });
    }
    res.json({ confirmed: false });
  } catch (e) {
    res.json({ confirmed: false });
  }
});

app.post('/api/withdraw-request', authMiddleware, async (req, res) => {
  try {
    const { telegram_id, ton_amount, wallet, username } = req.body;
    const { data: user } = await supabase
      .from('users')
      .select('ton_balance')
      .eq('telegram_id', String(telegram_id))
      .single();
    if (!user || user.ton_balance < ton_amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    await supabase.from('users').update({
      ton_balance: user.ton_balance - ton_amount,
    }).eq('telegram_id', String(telegram_id));
    await supabase.from('transactions').insert({
      telegram_id: String(telegram_id),
      type: 'withdraw',
      amount: ton_amount,
      currency: 'TON',
      status: 'pending',
      wallet_addr: wallet,
      description: `Вывод ${ton_amount} TON`,
      created_at: new Date().toISOString(),
    });
    await bot.api.sendMessage(ADMIN_ID,
      `⬆️ Заявка на вывод!\n👤 ${username || telegram_id}\n💎 ${ton_amount} TON\n👛 ${wallet}`
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/ton-rate', (req, res) => {
  res.json({ rate: tonRate, arc_per_ton: getArcPerTon() });
});

async function burnInactiveARC() {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: inactive } = await supabase
      .from('users')
      .select('telegram_id, arc_balance, last_seen')
      .lt('last_seen', sevenDaysAgo)
      .gt('arc_balance', 0);
    if (!inactive) return;
    for (const user of inactive) {
      const daysSince = Math.floor((Date.now() - new Date(user.last_seen)) / (24 * 60 * 60 * 1000));
      let burnPct = 0;
      if (daysSince === 7) burnPct = 0.20;
      else if (daysSince > 7) burnPct = 0.05;
      if (burnPct > 0) {
        const burned = Math.floor(user.arc_balance * burnPct);
        await supabase.from('users').update({
          arc_balance: user.arc_balance - burned,
        }).eq('telegram_id', user.telegram_id);
        try {
          await bot.api.sendMessage(Number(user.telegram_id),
            `🔥 Твои ARC начали гореть!\n\nТы не заходил ${daysSince} дней — сожжено ${burned} ARC.\n\nЗайди чтобы остановить!`
          );
        } catch (e) {}
      }
    }
  } catch (e) {}
}
setInterval(burnInactiveARC, 60 * 60 * 1000);

function scheduleReset() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const msUntilMidnight = midnight - now;
  setTimeout(async () => {
    await supabase.from('users').update({ exc_today: 0, checkin_done: false });
    scheduleReset();
  }, msUntilMidnight);
}
scheduleReset();

bot.command('start', async (ctx) => {
  const userId = ctx.from.id;
  const refCode = ctx.match || '';
  const webAppUrl = process.env.WEBAPP_URL;
  await fetch(`${webAppUrl}/api/user/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      telegram_id: userId,
      username: ctx.from.username || '',
      first_name: ctx.from.first_name || '',
      ref_code: refCode,
    }),
  }).catch(() => {});
  await ctx.reply('🖤 Добро пожаловать в Platform BLACK!\n\nЗарабатывай ARC — получай TON', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🚀 Открыть BLACK', web_app: { url: webAppUrl } }],
        [{ text: '📢 Канал', url: 'https://t.me/blackt_channel' }, { text: '💬 Поддержка', url: 'https://t.me/Ventlp' }]
      ]
    }
  });
});

bot.command('stats', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  try {
    const { count: totalUsers } = await supabase.from('users').select('*', { count: 'exact', head: true });
    const today = new Date(); today.setHours(0,0,0,0);
    const { count: newToday } = await supabase.from('users')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', today.toISOString());
    const { data: balances } = await supabase.from('users').select('arc_balance, ton_balance');
    const totalARC = balances?.reduce((s, u) => s + (u.arc_balance || 0), 0) || 0;
    const totalTON = balances?.reduce((s, u) => s + (u.ton_balance || 0), 0) || 0;
    await ctx.reply(
      `📊 Статистика BLACK\n\n` +
      `👥 Всего: ${totalUsers}\n` +
      `🆕 Сегодня: ${newToday}\n` +
      `💛 ARC: ${Math.floor(totalARC).toLocaleString()}\n` +
      `💎 TON: ${totalTON.toFixed(3)}\n` +
      `📈 Курс: $${tonRate}`
    );
  } catch (e) {
    await ctx.reply('Ошибка: ' + e.message);
  }
});

app.get('/tonconnect-manifest.json', (req, res) => {
  res.json({
    url: process.env.WEBAPP_URL,
    name: 'Platform BLACK',
    iconUrl: process.env.WEBAPP_URL + '/icon.png',
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 80;
app.listen(PORT, () => console.log(`BLACK running on port ${PORT}`));

async function startBot() {
  try {
    await bot.start();
  } catch(err) {
    if(err.error_code === 409) {
      console.log('409 conflict, waiting 10s...');
      await new Promise(r => setTimeout(r, 10000));
      await startBot();
    }
  }
}
startBot();
