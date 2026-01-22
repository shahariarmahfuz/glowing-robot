export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Basic health
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("OK ✅");
    }

    // Verify route exists in browser
    if (request.method === "GET" && url.pathname === "/webhook") {
      return new Response("Webhook ready ✅ (Telegram uses POST)", { status: 200 });
    }

    // Telegram webhook (POST)
    if (request.method === "POST" && url.pathname === "/webhook") {
      try {
        // IMPORTANT: never access env outside fetch
        const token = env.BOT_TOKEN;
        const targetChatId = env.TARGET_CHAT_ID;

        if (!token) {
          console.log("ERROR: Missing BOT_TOKEN");
          return new Response("ok", { status: 200 });
        }
        if (!targetChatId) {
          console.log("ERROR: Missing TARGET_CHAT_ID");
          return new Response("ok", { status: 200 });
        }

        const update = await request.json();
        const msg = update.message || update.edited_message;

        if (!msg) return new Response("ok", { status: 200 });

        const chatId = msg.chat.id;
        const text = msg.text || "";

        // Reply to start for testing
        if (text === "/start") {
          await tgSendMessage(token, chatId, "✅ Connected. এখন যাই পাঠাবে, সব তোমার চ্যানেলে যাবে।");
          return new Response("ok", { status: 200 });
        }

        // Forward everything else
        await tgForwardMessage(token, targetChatId, chatId, msg.message_id);

        return new Response("ok", { status: 200 });
      } catch (e) {
        console.log("Webhook exception:", e?.stack || e?.message || String(e));
        return new Response("ok", { status: 200 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
};

async function tgSendMessage(token, chatId, text) {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const t = await r.text();
  if (!r.ok) console.log("sendMessage failed:", t);
}

async function tgForwardMessage(token, toChatId, fromChatId, messageId) {
  const r = await fetch(`https://api.telegram.org/bot${token}/forwardMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: toChatId,
      from_chat_id: fromChatId,
      message_id: messageId,
    }),
  });
  const t = await r.text();
  if (!r.ok) console.log("forwardMessage failed:", t);
}
