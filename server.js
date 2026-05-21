const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { Bot } = require('grammy');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ADMIN_ID = 5839503796;
const PLATFORM_WALLET = 'UQAG8cx9dXAWIfcoNUkdyki-Un9QzJxw3_xU8624H6OnZFMb';
const CHANNEL = 'blackt_channel';
const ARC_PRICE_USD = 0.0003; // 1 ARC = 0.0003$

const bot = new Bot(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ──────────────────────────────────────────────────────────────────
// Telegram initData validation
// ──────────────────────────────────────────────────────────────────
function verifyTelegramInitData(initData) {
  if (!initData) return false;
  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(BOT_TOKEN)
    .digest();
  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get('hash');
  urlParams.delete('hash');
  const dataCheckString = [...urlParams.entries()]
    .sort()
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const hmac = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');
  return hmac === hash;
}

// Middleware для защиты API (кроме /api/me и /api/pvp/state)
function authMiddleware(req, res, next) {
  const initData = req.headers['x-telegram-init-data'] || req.body.initData;
  if (!initData) {
    return res.status(401).json({ error: 'Missing initData' });
  }
  if (!verifyTelegramInitData(initData)) {
    return res.status(401).json({ error: 'Invalid initData' });
  }
  // Извлекаем telegram_id из initData для дальнейшей проверки
  const params = new URLSearchParams(initData);
  const userRaw = params.get('user');
  if (!userRaw) {
    return res.status(401).json({ error: 'User not found in initData' });
  }
  const user = JSON.parse(userRaw);
  req.telegramUser = user;
  // Если в теле запроса есть telegram_id, проверяем соответствие
  if (req.body.telegram_id && String(req.body.telegram_id) !== String(user.id)) {
    return res.status(403).json({ error: 'Telegram ID mismatch' });
  }
  next();
}

// ──────────────────────────────────────────────────────────────────
// Вспомогательные функции
// ──────────────────────────────────────────────────────────────────
let tonRateUSD = 1.33; // дефолт
async function fetchTonRate() {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd');
    const d = await r.json();
    tonRateUSD = d['the-open-network']?.usd || tonRateUSD;
  } catch (e) {}
}
fetchTonRate();
setInterval(fetchTonRate, 10 * 60 * 1000);

function getArcPerTon() {
  return Math.floor(tonRateUSD / ARC_PRICE_USD);
}

// ──────────────────────────────────────────────────────────────────
// PvP state (in-memory, при рестарте сбрасывается — допустимо)
// ──────────────────────────────────────────────────────────────────
let currentRound = {
  id: 1,
  status: 'waiting',   // waiting, countdown, spinning
  players: [],         // { telegram_id, username, bet, addedAt }
  waitingTimer: null,  // для таймера 60 сек при одном игроке
  countdownEndTime: null,
  winner: null,
  totalPool: 0,
};

// Функция сохранения раунда в историю и очистки currentRound
async function finalizeRound(winnerPlayer, totalPool, fee, winnerAmount, players) {
  // Сохраняем в pvp_rounds
  const roundRecord = {
    round_id: currentRound.id,
    winner_id: winnerPlayer.telegram_id,
    winner_name: winnerPlayer.username || 'Player',
    winner_amount: winnerAmount,
    total_pool: totalPool,
    fee: fee,
    players: players.map(p => ({
      telegram_id: p.telegram_id,
      username: p.username,
      bet: p.bet
    }))
  };
  await supabase.from('pvp_rounds').insert(roundRecord);

  // Обновляем total_pvp_bet для всех участников (суммируем их ставки)
  for (const p of players) {
    const { data: user } = await supabase
      .from('users')
      .select('total_pvp_bet')
      .eq('telegram_id', p.telegram_id)
      .single();
    const newTotal = (user?.total_pvp_bet || 0) + p.bet;
    await supabase
      .from('users')
      .update({ total_pvp_bet: newTotal })
      .eq('telegram_id', p.telegram_id);
  }
}

// Запуск таймера ожидания для одного игрока
function startWaitingTimer() {
  if (currentRound.waitingTimer) clearTimeout(currentRound.waitingTimer);
  if (currentRound.players.length !== 1) return;
  currentRound.waitingTimer = setTimeout(async () => {
    // Если до сих пор 1 игрок и статус waiting
    if (currentRound.players.length === 1 && currentRound.status === 'waiting') {
      const solo = currentRound.players[0];
      // Возвращаем ставку
      const { data: user } = await supabase
        .from('users')
        .select('arc_balance')
        .eq('telegram_id', solo.telegram_id)
        .single();
      if (user) {
        await supabase
          .from('users')
          .update({ arc_balance: user.arc_balance + solo.bet })
          .eq('telegram_id', solo.telegram_id);
      }
      // Очищаем раунд
      currentRound.players = [];
      currentRound.totalPool = 0;
      currentRound.status = 'waiting';
      currentRound.winner = null;
      currentRound.waitingTimer = null;
      // Оповещаем через бота (опционально)
      bot.api.sendMessage(Number(solo.telegram_id), '⏰ Ставка возвращена — никто не пришёл за 60 секунд.');
    }
  }, 60000);
}

// Запуск обратного отсчёта (при >=2 игроках)
function startCountdown() {
  if (currentRound.status !== 'waiting') return;
  currentRound.status = 'countdown';
  currentRound.countdownEndTime = Date.now() + 15000;
  if (currentRound.waitingTimer) {
    clearTimeout(currentRound.waitingTimer);
    currentRound.waitingTimer = null;
  }
}

// Логика выбора победителя и завершения раунда
async function spinAndFinish() {
  if (currentRound.status !== 'countdown') return;
  if (Date.now() < currentRound.countdownEndTime) return;

  currentRound.status = 'spinning';
  const total = currentRound.totalPool;
  if (total === 0 || currentRound.players.length === 0) {
    // Аномалия – просто сбрасываем
    currentRound = {
      id: currentRound.id + 1,
      status: 'waiting',
      players: [],
      waitingTimer: null,
      countdownEndTime: null,
      winner: null,
      totalPool: 0,
    };
    return;
  }

  // Weighted random
  let rand = Math.random() * total;
  let winnerPlayer = null;
  for (const p of currentRound.players) {
    rand -= p.bet;
    if (rand <= 0) {
      winnerPlayer = p;
      break;
    }
  }
  if (!winnerPlayer) winnerPlayer = currentRound.players[0];

  const fee = Math.floor(total * 0.10);
  const winAmount = total - fee;

  // Начисляем победителю
  const { data: winnerUser } = await supabase
    .from('users')
    .select('arc_balance')
    .eq('telegram_id', winnerPlayer.telegram_id)
    .single();
  const newBalance = (winnerUser?.arc_balance || 0) + winAmount;
  await supabase
    .from('users')
    .update({ arc_balance: newBalance })
    .eq('telegram_id', winnerPlayer.telegram_id);

  // Запись транзакции
  await supabase.from('transactions').insert({
    telegram_id: winnerPlayer.telegram_id,
    type: 'pvp_win',
    amount: winAmount,
    currency: 'ARC',
    description: `Победа в PvP раунде #${currentRound.id}`,
    created_at: new Date().toISOString(),
  });

  // Сохраняем историю раунда
  await finalizeRound(winnerPlayer, total, fee, winAmount, currentRound.players);

  // Сохраняем winner в state для отображения клиентам
  currentRound.winner = {
    telegram_id: winnerPlayer.telegram_id,
    username: winnerPlayer.username,
    amount: winAmount,
    chance: Number(((winnerPlayer.bet / total) * 100).toFixed(2)),
  };

  // Через 4 секунды создаём новый раунд
  setTimeout(() => {
    currentRound = {
      id: currentRound.id + 1,
      status: 'waiting',
      players: [],
      waitingTimer: null,
      countdownEndTime: null,
      winner: null,
      totalPool: 0,
    };
  }, 4000);
}

// Планировщик для проверки countdown и spinning
setInterval(() => {
  if (currentRound.status === 'countdown' && Date.now() >= currentRound.countdownEndTime) {
    spinAndFinish();
  }
}, 100);

// ──────────────────────────────────────────────────────────────────
// API endpoints
// ──────────────────────────────────────────────────────────────────

// Получение информации о пользователе (без обязательной авторизации, но с проверкой)
app.get('/api/user/:tgId', authMiddleware, async (req, res) => {
  try {
    const { tgId } = req.params;
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('telegram_id', String(tgId))
      .single();
    if (error || !data) return res.json({ arc_balance: 0, ton_balance: 0, multiplier: 1.0 });
    const { data: refs } = await supabase
      .from('referrals')
      .select('referred_id, earned_arc')
      .eq('referrer_id', String(tgId));
    const { data: txs } = await supabase
      .from('transactions')
      .select('*')
      .eq('telegram_id', String(tgId))
      .order('created_at', { ascending: false })
      .limit(50);
    res.json({
      ...data,
      friends: refs || [],
      transactions: txs || [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Сохранение (обновление) пользователя
app.post('/api/user/save', authMiddleware, async (req, res) => {
  try {
    const { telegram_id, arc_balance, multiplier, checkin_day, checkin_done, exc_today, done_tasks, wallet_addr, used_promos } = req.body;
    if (!telegram_id) return res.status(400).json({ error: 'No telegram_id' });
    const updateData = {
      telegram_id: String(telegram_id),
      arc_balance: arc_balance ?? 0,
      multiplier: multiplier ?? 1.0,
      exc_today: exc_today ?? 0,
      done_tasks: done_tasks ?? [],
      wallet_addr: wallet_addr ?? '',
      last_seen: new Date().toISOString(),
    };
    if (checkin_day !== undefined) updateData.checkin_day = checkin_day;
    if (checkin_done !== undefined) updateData.checkin_done = checkin_done;
    if (used_promos !== undefined) updateData.used_promos = used_promos;
    const { error } = await supabase.from('users').upsert(updateData);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Регистрация
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
        pvp_history: [], // deprecated, скоро удалим
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

// Лидерборд PvP (по total_pvp_bet)
app.get('/api/leaderboard', authMiddleware, async (req, res) => {
  try {
    const type = req.query.type || 'pvp';
    if (type === 'pvp') {
      const { data } = await supabase
        .from('users')
        .select('telegram_id, username, first_name, photo_url, total_pvp_bet')
        .order('total_pvp_bet', { ascending: false })
        .limit(50);
      const result = (data || []).map(u => ({
        name: u.username ? '@' + u.username : u.first_name || 'Игрок',
        init: (u.first_name || u.username || 'U')[0].toUpperCase(),
        photo: u.photo_url || null,
        val: u.total_pvp_bet || 0,
      }));
      return res.json(result);
    } else {
      // Рекламный лидерборд (заглушка)
      return res.json([]);
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// История PvP (последние 30 раундов)
app.get('/api/pvp/history', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabase
      .from('pvp_rounds')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(30);
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PvP: присоединиться или добавить ставку
app.post('/api/pvp/join', authMiddleware, async (req, res) => {
  try {
    const { telegram_id, bet } = req.body;
    const amt = Number(bet);
    if (amt < 1) return res.status(400).json({ error: 'Minimum 1 ARC' });

    // Запрет, если раунд уже spinning или finished (winner есть)
    if (currentRound.status !== 'waiting' && currentRound.status !== 'countdown') {
      return res.status(400).json({ error: 'Round already in progress' });
    }

    const { data: user } = await supabase
      .from('users')
      .select('arc_balance, username')
      .eq('telegram_id', String(telegram_id))
      .single();
    if (!user) return res.status(404).json({ error: 'User not found' });

    const existingPlayer = currentRound.players.find(p => p.telegram_id === String(telegram_id));
    const currentBet = existingPlayer ? existingPlayer.bet : 0;
    const newBet = currentBet + amt;
    if (newBet > 5000) return res.status(400).json({ error: 'Max 5000 ARC per player' });
    if (user.arc_balance < amt) return res.status(400).json({ error: 'Insufficient ARC' });

    // Списываем ARC
    await supabase
      .from('users')
      .update({ arc_balance: user.arc_balance - amt })
      .eq('telegram_id', String(telegram_id));

    if (existingPlayer) {
      existingPlayer.bet = newBet;
    } else {
      if (currentRound.players.length >= 10) {
        // Возвращаем ARC, так как не удалось добавить
        await supabase
          .from('users')
          .update({ arc_balance: user.arc_balance })
          .eq('telegram_id', String(telegram_id));
        return res.status(400).json({ error: 'Round is full (max 10 players)' });
      }
      currentRound.players.push({
        telegram_id: String(telegram_id),
        username: user.username || 'Player',
        bet: newBet,
      });
    }

    // Пересчёт totalPool
    currentRound.totalPool = currentRound.players.reduce((s, p) => s + p.bet, 0);

    // Управление таймерами и статусами
    if (currentRound.players.length === 1 && currentRound.status === 'waiting') {
      startWaitingTimer();
    } else if (currentRound.players.length >= 2 && currentRound.status === 'waiting') {
      // Отменяем waitingTimer и запускаем countdown
      if (currentRound.waitingTimer) {
        clearTimeout(currentRound.waitingTimer);
        currentRound.waitingTimer = null;
      }
      startCountdown();
    } // Если уже countdown – ничего не меняем

    res.json({ ok: true, round: { id: currentRound.id, status: currentRound.status, totalPool: currentRound.totalPool } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PvP: получение текущего состояния
app.get('/api/pvp/state', async (req, res) => {
  try {
    let countdown = null;
    if (currentRound.status === 'countdown' && currentRound.countdownEndTime) {
      countdown = Math.max(0, Math.ceil((currentRound.countdownEndTime - Date.now()) / 1000));
    }
    const players = currentRound.players.map(p => ({
      telegram_id: p.telegram_id,
      username: p.username,
      bet: p.bet,
      chance: currentRound.totalPool ? Number(((p.bet / currentRound.totalPool) * 100).toFixed(2)) : 0,
    }));
    res.json({
      roundId: currentRound.id,
      status: currentRound.status,
      countdown,
      totalPool: currentRound.totalPool,
      players,
      winner: currentRound.winner,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Обмен TON → ARC
app.post('/api/exchange', authMiddleware, async (req, res) => {
  try {
    const { telegram_id, ton_amount } = req.body;
    const tonAmt = Number(ton_amount);
    if (tonAmt < 0.1) return res.status(400).json({ error: 'Minimum 0.1 TON' });
    const { data: user } = await supabase
      .from('users')
      .select('ton_balance, arc_balance, exc_today')
      .eq('telegram_id', String(telegram_id))
      .single();
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.ton_balance < tonAmt) return res.status(400).json({ error: 'Insufficient TON' });
    const todayUsed = user.exc_today || 0;
    if (todayUsed + tonAmt > 5) return res.status(400).json({ error: 'Daily limit 5 TON' });
    const arcAmount = Math.floor(tonAmt * getArcPerTon());
    if (arcAmount < 1) return res.status(400).json({ error: 'Amount too small' });

    await supabase.from('users').update({
      ton_balance: user.ton_balance - tonAmt,
      arc_balance: user.arc_balance + arcAmount,
      exc_today: todayUsed + tonAmt,
    }).eq('telegram_id', String(telegram_id));

    await supabase.from('transactions').insert({
      telegram_id: String(telegram_id),
      type: 'exchange',
      amount: arcAmount,
      currency: 'ARC',
      description: `Обмен ${tonAmt} TON → ${arcAmount} ARC`,
      created_at: new Date().toISOString(),
    });

    res.json({ ok: true, arc_credited: arcAmount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Депозит: проверка (клиент опрашивает)
app.post('/api/check-deposit', authMiddleware, async (req, res) => {
  try {
    const { telegram_id, expected_ton } = req.body;
    const { data, error } = await supabase
      .from('transactions')
      .select('amount, created_at')
      .eq('telegram_id', String(telegram_id))
      .eq('type', 'deposit')
      .eq('currency', 'TON')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    if (error || !data) return res.json({ confirmed: false });
    const ok = expected_ton ? Number(data.amount) >= Number(expected_ton) - 0.000001 : true;
    res.json({ confirmed: ok, amount: data.amount });
  } catch (e) {
    res.json({ confirmed: false });
  }
});

// Мониторинг депозитов (каждые 5 секунд)
async function monitorDeposits() {
  try {
    const response = await fetch(`https://toncenter.com/api/v2/getTransactions?address=${PLATFORM_WALLET}&limit=20`);
    const data = await response.json();
    const txs = data.result || [];
    for (const tx of txs) {
      const txHash = tx.transaction_id?.hash;
      if (!txHash) continue;
      const { data: existing } = await supabase
        .from('transactions')
        .select('id')
        .eq('tx_hash', txHash)
        .single();
      if (existing) continue;

      const msg = tx.in_msg || {};
      let comment = msg.message || msg.msg_data?.text || '';
            // Попытка декодировать base64
      try {
        const buf = Buffer.from(comment, 'base64');
        const decoded = buf.readUInt32BE(0) === 0 ? buf.subarray(4).toString('utf8') : buf.toString('utf8');
        if (decoded.includes('black_dep_')) comment = decoded;
      } catch (e) {}
      const match = comment.match(/black_dep_(\d+)/);
      if (match && match[1]) {
        const uid = match[1];
        const amountTon = Number(msg.value) / 1e9;
        if (amountTon >= 0.05) {
          const { data: user } = await supabase
            .from('users')
            .select('ton_balance')
            .eq('telegram_id', uid)
            .single();
          if (user) {
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
            bot.api.sendMessage(Number(uid), `✅ Депозит зачислен: +${amountTon.toFixed(3)} TON`);
            bot.api.sendMessage(ADMIN_ID, `💰 Депозит!\n👤 ID: ${uid}\n💎 ${amountTon.toFixed(3)} TON\n🔗 ${txHash}`);
          }
        }
      }
    }
  } catch (e) {}
}
setInterval(monitorDeposits, 5000);
monitorDeposits();

// Заявка на вывод
app.post('/api/withdraw-request', authMiddleware, async (req, res) => {
  try {
    const { telegram_id, ton_amount, wallet, username } = req.body;
    const amt = Number(ton_amount);
    if (amt < 0.1) return res.status(400).json({ error: 'Minimum 0.1 TON' });
    const { data: user } = await supabase
      .from('users')
      .select('ton_balance')
      .eq('telegram_id', String(telegram_id))
      .single();
    if (!user || user.ton_balance < amt) return res.status(400).json({ error: 'Insufficient TON' });
    await supabase.from('users').update({ ton_balance: user.ton_balance - amt }).eq('telegram_id', String(telegram_id));
    await supabase.from('transactions').insert({
      telegram_id: String(telegram_id),
      type: 'withdraw',
      amount: amt,
      currency: 'TON',
      status: 'pending',
      wallet_addr: wallet,
      description: `Вывод ${amt} TON`,
      created_at: new Date().toISOString(),
    });
    bot.api.sendMessage(ADMIN_ID, `⬆️ Заявка на вывод!\n👤 ${username || telegram_id}\n🆔 ${telegram_id}\n💎 ${amt} TON\n👛 ${wallet}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Отмена заявки на вывод (только если статус pending)
app.post('/api/withdraw-cancel', authMiddleware, async (req, res) => {
  try {
    const { transaction_id, telegram_id } = req.body;
    const { data: tx, error } = await supabase
      .from('transactions')
      .select('status, amount')
      .eq('id', transaction_id)
      .eq('telegram_id', String(telegram_id))
      .single();
    if (error || !tx || tx.status !== 'pending') {
      return res.status(400).json({ error: 'No pending withdrawal found' });
    }
    // Возвращаем TON на баланс
    const { data: user } = await supabase
      .from('users')
      .select('ton_balance')
      .eq('telegram_id', String(telegram_id))
      .single();
    if (user) {
      await supabase
        .from('users')
        .update({ ton_balance: user.ton_balance + tx.amount })
        .eq('telegram_id', String(telegram_id));
    }
    await supabase
      .from('transactions')
      .update({ status: 'cancelled' })
      .eq('id', transaction_id);
    bot.api.sendMessage(ADMIN_ID, `❌ Отмена вывода\nID: ${telegram_id}\nСумма: ${tx.amount} TON`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Сжигание ARC за неактивность
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
        if (burned > 0) {
          await supabase
            .from('users')
            .update({ arc_balance: user.arc_balance - burned })
            .eq('telegram_id', user.telegram_id);
          bot.api.sendMessage(Number(user.telegram_id),
            `🔥 Сожжено ${burned} ARC за неактивность ${daysSince} дней.\nЗаходите в игру, чтобы остановить сжигание!`
          );
        }
      }
    }
  } catch (e) {}
}
setInterval(burnInactiveARC, 60 * 60 * 1000);

// Предупреждения о скором сжигании (на 5 и 7 день)
async function warnInactiveUsers() {
  const day5 = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const day7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: users5 } = await supabase
    .from('users')
    .select('telegram_id, last_seen')
    .lt('last_seen', day5)
    .gt('last_seen', day7);
  for (const u of users5 || []) {
    bot.api.sendMessage(Number(u.telegram_id), '⚠️ Вы не заходили 5 дней. Если не зайдёте ещё 2 дня, с баланса ARC сгорит 20%!');
  }
  const { data: users7 } = await supabase
    .from('users')
    .select('telegram_id, last_seen')
    .lt('last_seen', day7);
  for (const u of users7 || []) {
    bot.api.sendMessage(Number(u.telegram_id), '🔥 Вы не заходили 7+ дней. ARC начали сгорать! Зайдите, чтобы остановить.');
  }
}
setInterval(warnInactiveUsers, 24 * 60 * 60 * 1000);

// Сброс ежедневных лимитов и чек-ина в полночь
function scheduleReset() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const ms = midnight - now;
  setTimeout(async () => {
    await supabase.from('users').update({ exc_today: 0, checkin_done: false });
    scheduleReset();
  }, ms);
}
scheduleReset();

// Проверка подписки на канал
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

// Текущий курс TON/ARC
app.get('/api/ton-rate', (req, res) => {
  res.json({ rate: tonRateUSD, arc_per_ton: getArcPerTon() });
});

// Эндпоинт для получения информации о пользователе из initData (для фронта)
app.post('/api/me', async (req, res) => {
  try {
    const { initData } = req.body;
    if (!initData) return res.status(400).json({ error: 'No initData' });
    if (!verifyTelegramInitData(initData)) return res.status(401).json({ error: 'Invalid initData' });
    const params = new URLSearchParams(initData);
    const userRaw = params.get('user');
    if (!userRaw) return res.status(400).json({ error: 'No user' });
    const user = JSON.parse(userRaw);
    res.json({
      id: user.id,
      username: user.username || '',
      first_name: user.first_name || '',
      photo_url: user.photo_url || '',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Статика и запуск
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

// Запуск бота
bot.start();
