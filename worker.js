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
      return new Response("Webhook ready ✅ (Telegram uses POST)", { status: 200 });
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
          const parts = text.split(" ");
          const payload = parts[1];

          if (!payload) {
            await tgSendMessage(chatId, "✅ Ready! ফাইল পাঠাও, আমি লিংক বানিয়ে দেব।");
            return new Response("ok", { status: 200 });
          }

          // token -> channel message lookup
          const row = await env.DB
            .prepare(
              "SELECT token, channel_chat_id, channel_message_id FROM files WHERE token = ?"
            )
            .bind(payload)
            .first();

          if (!row) {
            await tgSendMessage(chatId, "❌ এই লিংকটি পাওয়া যায়নি / ভুল টোকেন।");
            return new Response("ok", { status: 200 });
          }

          await env.DB
            .prepare("UPDATE files SET hits = hits + 1 WHERE token = ?")
            .bind(payload)
            .run();

          // Copy message from channel to user
          const copied = await tgCopyMessage(chatId, row.channel_chat_id, row.channel_message_id);

          const userMessageId = copied?.result?.message_id;
          if (!userMessageId) {
            // If copy failed, show reason in logs
            console.log("copyMessage response:", JSON.stringify(copied));
            await tgSendMessage(chatId, "⚠️ ফাইল পাঠাতে পারলাম না। পরে আবার চেষ্টা করো।");
            return new Response("ok", { status: 200 });
          }

          // Schedule deletion job (Cron will execute)
          await scheduleDeleteJob(env, String(chatId), Number(userMessageId), DELETE_AFTER_SECONDS);

          return new Response("ok", { status: 200 });
        }

        // For any other user message => forward to channel => save token => send link
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

  // Cron runs every minute
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processDeleteJobs(env));
  },
};

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

// --- D1 delete jobs ---
async function scheduleDeleteJob(env, chatId, messageId, seconds) {
  // D1 uses SQLite datetime
  await env.DB.prepare(
    "INSERT INTO delete_jobs (chat_id, message_id, due_at) VALUES (?, ?, datetime('now', ?))"
  )
    .bind(String(chatId), Number(messageId), `+${seconds} seconds`)
    .run();
}

async function processDeleteJobs(env) {
  // Take a batch to avoid long cron runtime
  const { results } = await env.DB.prepare(
    "SELECT id, chat_id, message_id FROM delete_jobs WHERE due_at <= datetime('now') ORDER BY due_at ASC LIMIT 50"
  ).all();

  if (!results || results.length === 0) return;

  for (const job of results) {
    try {
      // Try deleting the file message
      const del = await tgDeleteMessage(job.chat_id, job.message_id);

      // Always send notice (even if delete fails, user will know)
      // If you want: only send notice when delete ok, you can check del.ok
      await tgSendMessage(job.chat_id, DELETE_NOTICE_TEXT);

      // Remove job so we don't retry forever
      await env.DB.prepare("DELETE FROM delete_jobs WHERE id = ?").bind(job.id).run();

      if (del && del.ok !== true) {
        console.log("deleteMessage not ok:", JSON.stringify(del));
      }
    } catch (e) {
      console.log("process job error:", e?.stack || e?.message || String(e));
      // Remove job to prevent infinite retry; or keep it for retry—your choice
      await env.DB.prepare("DELETE FROM delete_jobs WHERE id = ?").bind(job.id).run();
    }
  }
}

// --- Telegram API helpers ---
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
    body: JSON.stringify({
      chat_id: toChatId,
      from_chat_id: fromChatId,
      message_id: messageId,
    }),
  });
  const out = await res.text();
  if (!res.ok) console.log("forwardMessage failed:", out);
  try { return JSON.parse(out); } catch { return { raw: out }; }
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
  try { return JSON.parse(out); } catch { return { raw: out }; }
}

async function tgDeleteMessage(chatId, messageId) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: Number(messageId),
    }),
  });
  const out = await res.text();
  if (!res.ok) console.log("deleteMessage failed:", out);
  try { return JSON.parse(out); } catch { return { raw: out }; }
}
