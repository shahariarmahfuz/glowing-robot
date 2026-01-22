import {
  BOT_TOKEN,
  TARGET_CHAT_ID,
  BOT_USERNAME,
  DELETE_AFTER_SECONDS,
  DELETE_NOTICE_TEXT,
} from "./config.js";

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

        // /start <token>
        if (text.startsWith("/start")) {
          const payload = text.split(" ")[1];

          if (!payload) {
            await tgSendMessage(chatId, "✅ Ready! ফাইল পাঠাও, আমি লিংক বানিয়ে দেব।");
            return new Response("ok", { status: 200 });
          }

          const row = await env.DB
            .prepare("SELECT channel_chat_id, channel_message_id FROM files WHERE token = ?")
            .bind(payload)
            .first();

          if (!row) {
            await tgSendMessage(chatId, "❌ এই লিংকটি পাওয়া যায়নি / ভুল টোকেন।");
            return new Response("ok", { status: 200 });
          }

          await env.DB.prepare("UPDATE files SET hits = hits + 1 WHERE token = ?")
            .bind(payload)
            .run();

          // Copy file from channel to user
          const copied = await tgCopyMessage(chatId, row.channel_chat_id, row.channel_message_id);
          const userMessageId = copied?.result?.message_id;

          if (!userMessageId) {
            console.log("copyMessage response:", JSON.stringify(copied));
            await tgSendMessage(chatId, "⚠️ ফাইল পাঠানো যায়নি। পরে আবার চেষ্টা করো।");
            return new Response("ok", { status: 200 });
          }

          // ✅ Perfect-timing delete via Durable Object alarm
          await scheduleDelete(env, String(chatId), Number(userMessageId), DELETE_AFTER_SECONDS);

          return new Response("ok", { status: 200 });
        }

        // Any other message => forward to channel => save token => send link
        const fwd = await tgForwardMessage(TARGET_CHAT_ID, chatId, msg.message_id);
        const channelMessageId = fwd?.result?.message_id;

        if (!channelMessageId) {
          console.log("forwardMessage response:", JSON.stringify(fwd));
          await tgSendMessage(chatId, "⚠️ ফরওয়ার্ড ঠিকমতো হয়নি। আবার চেষ্টা করো।");
          return new Response("ok", { status: 200 });
        }

        const token = generateToken();

        await env.DB.prepare(
          "INSERT INTO files (token, channel_chat_id, channel_message_id, from_user_id) VALUES (?, ?, ?, ?)"
        )
          .bind(token, String(TARGET_CHAT_ID), Number(channelMessageId), Number(chatId))
          .run();

        const link = `https://t.me/${BOT_USERNAME}?start=${token}`;
        await tgSendMessage(chatId, `✅ Link created:\n${link}`);

        return new Response("ok", { status: 200 });
      } catch (e) {
        console.log("Webhook error:", e?.stack || e?.message || String(e));
        return new Response("ok", { status: 200 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
};

// ---------------- Durable Object (Perfect Timer) ----------------
export class DeleteTimer {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/schedule") return new Response("Not found", { status: 404 });

    const { chatId, messageId, delaySeconds } = await request.json();

    // store job data
    await this.state.storage.put("job", { chatId, messageId });

    // set alarm precisely
    const when = Date.now() + Math.max(1, delaySeconds) * 1000;
    await this.state.storage.setAlarm(when);

    return new Response("scheduled", { status: 200 });
  }

  async alarm() {
    const job = await this.state.storage.get("job");
    if (!job) return;

    // delete message
    await tgDeleteMessage(job.chatId, job.messageId);

    // send notice
    await tgSendMessage(job.chatId, DELETE_NOTICE_TEXT);

    // cleanup
    await this.state.storage.deleteAll();
  }
}

async function scheduleDelete(env, chatId, messageId, delaySeconds) {
  // unique object per (chatId,messageId)
  const id = env.DEL.idFromName(`${chatId}:${messageId}`);
  const stub = env.DEL.get(id);

  await stub.fetch("https://do/schedule", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chatId, messageId, delaySeconds }),
  });
}

// ---------------- Helpers ----------------
function generateToken() {
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
  try { return JSON.parse(out); } catch { return { raw: out }; }
}

async function tgForwardMessage(toChatId, fromChatId, messageId) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/forwardMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: toChatId, from_chat_id: fromChatId, message_id: messageId }),
  });
  const out = await res.text();
  if (!res.ok) console.log("forwardMessage failed:", out);
  try { return JSON.parse(out); } catch { return { raw: out }; }
}

async function tgCopyMessage(toChatId, fromChatId, messageId) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/copyMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: toChatId, from_chat_id: fromChatId, message_id: messageId }),
  });
  const out = await res.text();
  if (!res.ok) console.log("copyMessage failed:", out);
  try { return JSON.parse(out); } catch { return { raw: out }; }
}

async function tgDeleteMessage(chatId, messageId) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: Number(messageId) }),
  });
  const out = await res.text();
  if (!res.ok) console.log("deleteMessage failed:", out);
  try { return JSON.parse(out); } catch { return { raw: out }; }
}
