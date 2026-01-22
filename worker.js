export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/" && request.method === "GET") {
      return new Response("OK ✅ Telegram Forwarder Bot is running");
    }

    // Webhook endpoint
    if (url.pathname === "/webhook" && request.method === "POST") {
      const update = await request.json();

      const token = env.BOT_TOKEN;
      const targetChatId = env.TARGET_CHAT_ID; // your private channel chat_id (e.g. -1001234567890)

      if (!token) return new Response("Missing BOT_TOKEN", { status: 500 });
      if (!targetChatId) return new Response("Missing TARGET_CHAT_ID", { status: 500 });

      const message =
        update.message ||
        update.edited_message ||
        update.channel_post ||
        update.edited_channel_post;

      // Nothing to forward
      if (!message) return new Response("No message to forward", { status: 200 });

      // Optional: ignore commands like /start
      const text = message.text || "";
      if (text.startsWith("/start")) {
        await sendMessage(token, message.chat.id, "✅ Connected. যা পাঠাবে সব তোমার চ্যানেলে যাবে।");
        return new Response("ok", { status: 200 });
      }

      // Forward user’s message to your channel
      await forwardMessage(token, targetChatId, message.chat.id, message.message_id);

      // Optional: confirm user
      // await sendMessage(token, message.chat.id, "✅ Sent to channel");

      return new Response("ok", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  },
};

async function forwardMessage(token, toChatId, fromChatId, messageId) {
  const res = await fetch(`https://api.telegram.org/bot${token}/forwardMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: toChatId,
      from_chat_id: fromChatId,
      message_id: messageId,
      // disable_notification: true, // চাইলে অন করো
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error("forwardMessage failed: " + errText);
  }
}

async function sendMessage(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}
