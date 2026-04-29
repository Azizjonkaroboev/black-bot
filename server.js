const express = require("express");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Главная страница — Mini App
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// API — получить данные пользователя
app.get("/api/user/:telegram_id", async (req, res) => {
  try {
    const { telegram_id } = req.params;
    res.json({
      telegram_id,
      arc_balance: 0,
      ton_balance: 0,
      multiplier: 1.0,
      checkin_day: 1,
      referrals: 0,
      language: "ru"
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API — просмотр рекламы
app.post("/api/ad/view", async (req, res) => {
  try {
    const { telegram_id, ad_number } = req.body;
    res.json({
      success: true,
      arc_earned: 5,
      message: "+5 ARC начислено!"
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API — чек-ин
app.post("/api/checkin", async (req, res) => {
  try {
    const { telegram_id } = req.body;
    res.json({
      success: true,
      day: 1,
      multiplier: 1.0,
      message: "Чек-ин выполнен!"
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API — PvP ставка
app.post("/api/pvp/bet", async (req, res) => {
  try {
    const { telegram_id, amount } = req.body;
    if (amount < 10) {
      return res.json({
        success: false,
        message: "Минимальная ставка 10 ARC!"
      });
    }
    res.json({
      success: true,
      message: "Ставка принята! Ждём соперника..."
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Админка
app.get("/admin", (req, res) => {
  res.send(`
    <html>
    <body style="background:#0a0a0a;color:#c9a84c;font-family:sans-serif;padding:20px">
      <h1>🖤 BLACK Admin</h1>
      <p>Панель управления в разработке...</p>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`BLACK server running on port ${PORT}`);
});

module.exports = app;
