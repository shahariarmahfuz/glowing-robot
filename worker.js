// ⚠️ TEST ONLY: Do NOT keep tokens in code for production.
// If this repo is public, anyone can take over your bot.
// After testing, rotate your bot token in BotFather.

const BOT_TOKEN = "7985415284:AAGtJ7CMy783_N2xq5hXuC8PkcPpdx2nCYQ";
const TARGET_CHAT_ID = "-1003591318904"; // your private channel id

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Health check
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("OK ✅");
    }

    // Verify endpoint in browser
    if (request.method === "GET" && url.pathname === "/webhook") {
      return new Response("Webhook ready ✅ (Telegram uses POST)", { status: 200 });
    }

    // Telegram webhook
    if (request.method === "POST" && url.pathname === "/webhook") {
      try {
        const update = await request.json();
        const msg = update.message || update.edited_message;

        if (!msg) return new Response("ok", { status: 200 });

        const chatId = msg.chat.id;
        const text = msg.text || "";

        // Reply to /start
        if (text === "/start") {
          await tgSendMessage(chatId, "✅ Connected. এখন যাই পাঠাবে, সব চ্যানেলে যাবে।");
          return new Response("ok", { status: 200 });
        }

        // Forward everything else to your private channel
        await tgForwardMessage(TARGET_CHAT_ID, chatId, msg.message_id);

        return new Response("ok", { status: 200 });
      } catch (e) {
        // Never return 500 to Telegram during testing
        console.log("Webhook error:", e?.stack || e?.message || String(e));
        return new Response("ok", { status: 200 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
};

async function tgSendMessage(chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });

  const out = await res.text();
  if (!res.ok) console.log("sendMessage failed:", out);
}

async function tgForwardMessage(toChatId, fromChatId, messageId) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/forwardMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: toChatId,
      from_chat_id: fromChatId,
      message_id: messageId,
    }),
  });

  const out = await res.text();
  if (!res.ok) console.log("forwardMessage failed:", out);
}
