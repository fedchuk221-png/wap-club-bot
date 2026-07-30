require("dotenv").config();

const token = process.env.BOT_TOKEN;
const publicUrl = process.env.PUBLIC_URL;

if (!token || !publicUrl) {
  console.error("Заполните BOT_TOKEN и PUBLIC_URL в переменных окружения перед запуском.");
  process.exit(1);
}

const webhookUrl = `${publicUrl.replace(/\/$/, "")}/webhook`;
const url = `https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(webhookUrl)}&drop_pending_updates=true`;

fetch(url)
  .then((r) => r.json())
  .then((data) => console.log("setWebhook response:", data))
  .catch((e) => console.error("setWebhook error:", e));
