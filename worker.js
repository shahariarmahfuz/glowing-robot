// ⚠️ TEST ONLY: production এ token hardcode দিও না
const BOT_TOKEN = "7985415284:AAGtJ7CMy783_N2xq5hXuC8PkcPpdx2nCYQ";
const TARGET_CHAT_ID = "-1003591318904"; // তোমার private channel id
const BOT_USERNAME = "terihasarbot";  // তোমার bot username (without @)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("OK ✅");
    }

    if (request.method === "GET" && url.pathname === "/webhook") {
      return new Response("Webhook ready ✅", { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      try {
        const update = await request.json();
        const msg = update.message || update.edited_message;
        if (!msg) return new Response("ok", { status: 200 });

        const chatId = msg.chat.id;
        const text = msg.text || "";

        // /start handler with payload: /start <token>
        if (text.startsWith("/start")) {
          const parts = text.split(" ");
          const payload = parts[1];

          // no payload => normal welcome
          if (!payload) {
            await tgSendMessage(chatId, "✅ Ready! ফাইল পাঠাও, আমি লিংক বানিয়ে দেব।");
            return new Response("ok", { status: 200 });
          }

          // payload => fetch mapping from D1 and send back
          const row = await env.DB
            .prepare("SELECT token, channel_chat_id, channel_message_id, hits FROM files WHERE token = ?")
            .bind(payload)
            .first();

          if (!row) {
            await tgSendMessage(chatId, "❌ এই লিংকটি পাওয়া যায়নি / মেয়াদ শেষ / ভুল টোকেন।");
            return new Response("ok", { status: 200 });
          }

          // increment hits
          await env.DB
            .prepare("UPDATE files SET hits = hits + 1 WHERE token = ?")
            .bind(payload)
            .run();

          // copy message from channel to user
          await tgCopyMessage(chatId, row.channel_chat_id, row.channel_message_id);

          return new Response("ok", { status: 200 });
        }

        // অন্য সব message: চ্যানেলে forward + token generate + save + link reply
        const fwd = await tgForwardMessage(TARGET_CHAT_ID, chatId, msg.message_id);

        // Telegram returns Message object; we need the new message_id in channel
        const channelMessageId = fwd?.result?.message_id;
        if (!channelMessageId) {
          console.log("Forward response:", JSON.stringify(fwd));
          await tgSendMessage(chatId, "⚠️ ফাইল ফরওয়ার্ড হয়েছে কি না নিশ্চিত হতে পারলাম না (no message_id). আবার চেষ্টা করো।");
          return new Response("ok", { status: 200 });
        }

        const token = generateToken(); // random short token

        await env.DB.prepare(
          "INSERT INTO files (token, channel_chat_id, channel_message_id, from_user_id) VALUES (?, ?, ?, ?)"
        )
          .bind(token, String(TARGET_CHAT_ID), Number(channelMessageId), Number(chatId))
          .run();

        const link = `https://t.me/${BOT_USERNAME}?start=${token}`;

        await tgSendMessage(
          chatId,
          `✅ Link created:\n${link}\n\nএই লিংকে গেলে আমি আবার একই ফাইল পাঠিয়ে দেব।`
        );

        return new Response("ok", { status: 200 });
      } catch (e) {
        console.log("Webhook error:", e?.stack || e?.message || String(e));
        // Telegram কে 200 দিলে retry spam কমে
        return new Response("ok", { status: 200 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
};

function generateToken() {
  // 12 bytes -> base64url ~16 chars
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function base64Url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

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

  const outText = await res.text();
  let out;
  try { out = JSON.parse(outText); } catch { out = { raw: outText }; }

  if (!res.ok) console.log("forwardMessage failed:", outText);
  return out;
}

async function tgCopyMessage(toChatId, fromChatId, messageId) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/copyMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: toChatId,
      from_chat_id: fromChatId,
      message_id: messageId,
    }),
  });

  const out = await res.text();
  if (!res.ok) console.log("copyMessage failed:", out);
}
