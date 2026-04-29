const { Bot, InlineKeyboard } = require("grammy");
require("dotenv").config();

const bot = new Bot(process.env.BOT_TOKEN);

bot.command("start", async (ctx) => {
  const keyboard = new InlineKeyboard()
    .webApp("🖤 Запустить BLACK", process.env.WEBAPP_URL)
    .row()
    .url("📢 Канал", process.env.CHANNEL_URL)
    .row()
    .url("🆘 Поддержка", process.env.SUPPORT_URL);

  await ctx.replyWithPhoto(
    process.env.PHOTO_URL || "https://i.imgur.com/placeholder.jpg",
    {
      caption:
        "🖤 *Platform BLACK*\n\n" +
        "Зарабатывай ARC — получай TON\n\n" +
        "Смотри рекламу, выполняй задания,\n" +
        "играй в PvP и получай TON каждые 30 дней!",
      parse_mode: "Markdown",
      reply_markup: keyboard,
    }
  );
});

bot.start();
