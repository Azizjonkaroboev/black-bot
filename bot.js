const { Bot, InlineKeyboard } = require("grammy");
const express = require("express");
const path = require("path");
require("dotenv").config();

// Сервер
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(80, () => {
  console.log("BLACK server running on port 80");
});

// Бот
const bot = new Bot(process.env.BOT_TOKEN);

bot.command("start", async (ctx) => {
  const keyboard = new InlineKeyboard()
    .webApp("🖤 Запустить BLACK", process.env.WEBAPP_URL)
    .row()
    .url("📢 Канал", process.env.CHANNEL_URL)
    .row()
    .url("🆘 Поддержка", process.env.SUPPORT_URL);

  await ctx.reply(
    "🖤 *Platform BLACK*\n\nЗарабатывай ARC — получай TON!",
    { parse_mode: "Markdown", reply_markup: keyboard }
  );
});

bot.start();
