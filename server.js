const express = require('express');
const crypto = require('crypto');
const ws = require('ws');
const { createClient } = require('@supabase/supabase-js');
const { Bot } = require('grammy');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

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

// ══ GET USER ══
app.use((req,res,next)=>{console.log(req.method,req.url);next();});
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
    return res.json({
      ...data,
      friends: refs || [],
      transactions: txs || [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══ SAVE USER (ИСПРАВЛЕН баг checkin_day + добавлены pvp_history и used_promos) ══
app.post('/api/user/save', authMiddleware, async (req, res) => {
  try {
    const {
      telegram_id, arc_balance, ton_balance, multiplier,
      checkin_day, checkin_done, exc_today, done_tasks,
      wallet_addr, pvp_history, used_promos
    } = req.body;
    if (!telegram_id) return res.status(400).json({ error: 'No telegram_id' });

    const updateData = {
      telegram_id: String(telegram_id),
      arc_balance: arc_balance ?? 0,
      ton_balance: ton_balance ?? 0,
      multiplier: multiplier ?? 1.0,
      exc_today: exc_today ?? 0,
      done_tasks: done_tasks ?? [],
      wallet_addr: wallet_addr ?? '',
      last_seen: new Date().toISOString(),
    };

    // ВАЖНО: не перезаписываем checkin_day/checkin_done если не пришли
    if (checkin_day !== undefined) updateData.checkin_day = checkin_day;
    if (checkin_done !== undefined) updateData.checkin_done = checkin_done;

    // Сохраняем pvp_history и used_promos если пришли
    if (pvp_history !== undefined) updateData.pvp_history = pvp_history;
    if (used_promos !== undefined) updateData.used_promos = used_promos;

    const { error } = await supabase.from('users').upsert(updateData);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══ REGISTER ══
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
        pvp_history: [],
        used_promos: [],
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

// ══ LEADERBOARD (НОВЫЙ ENDPOINT) ══
app.get('/api/leaderboard', authMiddleware, async (req, res) => {
  try {
    const type = req.query.type || 'pvp';
    if (type === 'pvp') {
      const { data } = await supabase
        .from('users')
        .select('telegram_id, username, first_name, photo_url, arc_balance')
        .order('arc_balance', { ascending: false })
        .limit(50);
      const result = (data || []).map(u => ({
        name: u.username ? '@' + u.username : u.first_name || 'Игрок',
        init: (u.first_name || u.username || 'U')[0].toUpperCase(),
        photo: u.photo_url || null,
        val: u.arc_balance || 0,
      }));
      return res.json(result);
    } else {
      // ad views — пока возвращаем пустой (реклама ещё не активна)
      return res.json([]);
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══ CHECK SUBSCRIPTION ══
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

// ══ EXCHANGE ══
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

// ══ CHECK DEPOSIT ══
app.post('/api/check-deposit', authMiddleware, async (req, res) => {
  res.json({ confirmed: false, monitoring: true });
});

async function monitorDeposits() {
  try {
    const response = await fetch(
      `https://toncenter.com/api/v2/getTransactions?address=${PLATFORM_WALLET}&limit=50`
    );
    const data = await response.json();
    const txs = data.result || [];
    for (const tx of txs) {
      try {
        const txHash = tx.transaction_id?.hash || '';
        if (!txHash) continue;
        const { data: existing } = await supabase
          .from('transactions').select('id').eq('tx_hash', txHash).single();
        if (existing) continue;
        const msg = tx.in_msg || {};
        const rawComment =
  msg.message ||
  msg.msg_data?.text ||
  msg.msg_data?.body ||
  '';
        let comment = rawComment;
        try {
   const buf=Buffer.from(rawComment,'base64');
const decoded=buf.readUInt32BE(0)===0?buf.subarray(4).toString('utf8'):buf.toString('utf8');

  const match = decoded.match(/black_dep_\d+/);
  if (match) {
    comment = match[0];
  }
} catch(e) {}
        console.log('TX comment:', comment, 'raw:', rawComment);
        const amountTon = Number(msg.value || 0) / 1e9;
        if (comment && comment.startsWith('black_dep_') && amountTon >= 0.05) {
          const uid = comment.replace('black_dep_', '').trim();
          const { data: user } = await supabase
            .from('users').select('ton_balance').eq('telegram_id', uid).single();
          if (!user) continue;
          const newBalance = (user.ton_balance || 0) + amountTon;
          await supabase.from('users').update({ ton_balance: newBalance }).eq('telegram_id', uid);
          await supabase.from('transactions').insert({
            telegram_id: uid,
            type: 'deposit',
            amount: amountTon,
            currency: 'TON',
            tx_hash: txHash,
            description: `Депозит ${amountTon.toFixed(3)} TON`,
            created_at: new Date().toISOString(),
          });
          try {
            await bot.api.sendMessage(Number(uid), `✅ Депозит зачислен: +${amountTon.toFixed(3)} TON`);
            await bot.api.sendMessage(ADMIN_ID, `💰 Депозит!\n👤 ID: ${uid}\n💎 ${amountTon.toFixed(3)} TON\n💰 Баланс: ${newBalance.toFixed(3)} TON`);
          } catch(e) {}
        }
      } catch(e) { console.log('TX error:', e.message); }
    }
  } catch(e) { console.log('Monitor error:', e.message); }
}
setInterval(monitorDeposits, 30000);
monitorDeposits();

// ══ WITHDRAW ══
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

// ══ TON RATE ══
app.get('/api/ton-rate', (req, res) => {
  res.json({ rate: tonRate, arc_per_ton: getArcPerTon() });
});

// ══ BURN INACTIVE ARC ══
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

// ══ DAILY RESET (exc_today и checkin_done) ══
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

// ══ BOT COMMANDS ══
bot.command('start', async (ctx) => {
  const userId = ctx.from.id;
  const refCode = ctx.message?.text?.split(' ')[1] || '';
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

// ══ STATIC ══
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

function verifyTelegramInitData(initData){

  const secretKey = crypto
    .createHmac('sha256','WebAppData')
    .update(BOT_TOKEN)
    .digest();

  const urlParams = new URLSearchParams(initData);

  const hash = urlParams.get('hash');

  urlParams.delete('hash');

  const dataCheckString = [...urlParams.entries()]
    .sort()
    .map(([k,v])=>`${k}=${v}`)
    .join('\n');

  const hmac = crypto
    .createHmac('sha256',secretKey)
    .update(dataCheckString)
    .digest('hex');

  return hmac === hash;
}

app.post('/api/me', async(req,res)=>{

  try{

    const { initData } = req.body;

    if(!initData){
      return res.status(400).json({
        error:'No initData'
      });
    }

    const valid =
      verifyTelegramInitData(initData);

    if(!valid){
      return res.status(401).json({
        error:'Invalid initData'
      });
    }

    const params =
      new URLSearchParams(initData);

    const userRaw = params.get('user');

    if(!userRaw){
      return res.status(400).json({
        error:'No user'
      });
    }

    const user = JSON.parse(userRaw);

    res.json({
      id:user.id,
      username:user.username||'',
      first_name:user.first_name||'',
      photo_url:user.photo_url||''
    });

  }catch(e){

    res.status(500).json({
      error:e.message
    });

  }

});
// ══ START ══
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
