const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Run this ONCE to create all tables
async function createTables() {
  // Users table
  await supabase.rpc('exec_sql', { sql: `
    CREATE TABLE IF NOT EXISTS users (
      telegram_id TEXT PRIMARY KEY,
      username TEXT DEFAULT '',
      first_name TEXT DEFAULT '',
      photo_url TEXT DEFAULT '',
      arc_balance DECIMAL DEFAULT 0,
      ton_balance DECIMAL DEFAULT 0,
      multiplier DECIMAL DEFAULT 1.0,
      checkin_day INTEGER DEFAULT 1,
      checkin_done BOOLEAN DEFAULT false,
      exc_today DECIMAL DEFAULT 0,
      done_tasks TEXT[] DEFAULT '{}',
      wallet_addr TEXT DEFAULT '',
      ref_code TEXT DEFAULT '',
      inactivity_warned BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW(),
      last_seen TIMESTAMP DEFAULT NOW()
    );
  `});

  // Transactions table
  await supabase.rpc('exec_sql', { sql: `
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      telegram_id TEXT REFERENCES users(telegram_id),
      type TEXT,
      amount DECIMAL,
      currency TEXT,
      status TEXT DEFAULT 'completed',
      tx_hash TEXT DEFAULT '',
      wallet_addr TEXT DEFAULT '',
      description TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `});

  // Referrals table
  await supabase.rpc('exec_sql', { sql: `
    CREATE TABLE IF NOT EXISTS referrals (
      id SERIAL PRIMARY KEY,
      referrer_id TEXT REFERENCES users(telegram_id),
      referred_id TEXT REFERENCES users(telegram_id),
      earned_arc DECIMAL DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `});

  // PvP games table
  await supabase.rpc('exec_sql', { sql: `
    CREATE TABLE IF NOT EXISTS pvp_games (
      id SERIAL PRIMARY KEY,
      round_number INTEGER,
      winner_id TEXT,
      winner_name TEXT,
      pot_arc DECIMAL,
      fee_arc DECIMAL,
      win_chance DECIMAL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `});

  console.log('Tables created!');
}

module.exports = { supabase, createTables };
