const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Создать таблицы
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT,
      arc_balance NUMERIC DEFAULT 0,
      ton_balance NUMERIC DEFAULT 0,
      multiplier NUMERIC DEFAULT 1.0,
      checkin_day INT DEFAULT 1,
      checkin_date DATE,
      referral_id BIGINT,
      language TEXT DEFAULT 'ru',
      is_banned BOOLEAN DEFAULT FALSE,
      last_active TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT,
      action TEXT,
      amount NUMERIC,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ad_views (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT,
      ad_number INT,
      viewed_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pvp_games (
      id SERIAL PRIMARY KEY,
      round_number INT DEFAULT 1,
      status TEXT DEFAULT 'waiting',
      total_bank NUMERIC DEFAULT 0,
      winner_id BIGINT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pvp_bets (
      id SERIAL PRIMARY KEY,
      game_id INT,
      telegram_id BIGINT,
      amount NUMERIC,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS promo_codes (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE,
      arc_reward NUMERIC,
      uses_left INT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log("✅ База данных инициализирована");
}

// Получить пользователя
async function getUser(telegram_id) {
  const res = await pool.query(
    "SELECT * FROM users WHERE telegram_id = $1",
    [telegram_id]
  );
  return res.rows[0];
}

// Создать пользователя
async function createUser(telegram_id, username, referral_id = null) {
  const res = await pool.query(
    `INSERT INTO users (telegram_id, username, referral_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id) DO NOTHING
     RETURNING *`,
    [telegram_id, username, referral_id]
  );
  return res.rows[0];
}

// Добавить ARC
async function addARC(telegram_id, amount, action) {
  await pool.query(
    "UPDATE users SET arc_balance = arc_balance + $1 WHERE telegram_id = $2",
    [amount, telegram_id]
  );
  await pool.query(
    "INSERT INTO transactions (telegram_id, action, amount) VALUES ($1, $2, $3)",
    [telegram_id, action, amount]
  );
}

// Сжечь ARC
async function burnARC(telegram_id, percent) {
  await pool.query(
    `UPDATE users 
     SET arc_balance = arc_balance * (1 - $1/100.0)
     WHERE telegram_id = $2`,
    [percent, telegram_id]
  );
  await pool.query(
    `INSERT INTO transactions (telegram_id, action, amount)
     SELECT $1, 'burn_' || $2 || '%', arc_balance * ($2/100.0)
     FROM users WHERE telegram_id = $1`,
    [telegram_id, percent]
  );
}

// Просмотры рекламы за сегодня
async function getAdViewsToday(telegram_id, ad_number) {
  const res = await pool.query(
    `SELECT COUNT(*) FROM ad_views
     WHERE telegram_id = $1
     AND ad_number = $2
     AND viewed_at::date = CURRENT_DATE`,
    [telegram_id, ad_number]
  );
  return parseInt(res.rows[0].count);
}

// Записать просмотр рекламы
async function recordAdView(telegram_id, ad_number) {
  await pool.query(
    "INSERT INTO ad_views (telegram_id, ad_number) VALUES ($1, $2)",
    [telegram_id, ad_number]
  );
}

// Обновить последнюю активность
async function updateActivity(telegram_id) {
  await pool.query(
    "UPDATE users SET last_active = NOW() WHERE telegram_id = $1",
    [telegram_id]
  );
}

module.exports = {
  initDB,
  getUser,
  createUser,
  addARC,
  burnARC,
  getAdViewsToday,
  recordAdView,
  updateActivity,
  pool
};
