import {
  BOT_TOKEN,
  TARGET_CHAT_ID,
  BOT_USERNAME,
  EXPIRE_SECONDS,
  TIMEZONE,
} from "./config.js";

/**
 * MAIN WORKER
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // health
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("OK ✅");
    }

    // browser check
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

        // ------------- /start <token> -------------
        if (text.startsWith("/start")) {
          const token = text.split(" ")[1];

          if (!token) {
            await tgSendMessage(chatId, "✅ Ready!\nফাইল পাঠাও—আমি তোমাকে shareable link বানিয়ে দেব।");
            return new Response("ok", { status: 200 });
          }

          const row = await env.DB.prepare(
            "SELECT channel_chat_id, channel_message_id, uploaded_at, kind FROM files WHERE token = ?"
          ).bind(token).first();

          if (!row) {
            await tgSendMessage(chatId, "❌ এই লিংকটি পাওয়া যায়নি / ভুল টোকেন।");
            return new Response("ok", { status: 200 });
          }

          // copy message from channel to user
          const copied = await tgCopyMessage(chatId, row.channel_chat_id, row.channel_message_id);
          const userMessageId = copied?.result?.message_id;

          if (!userMessageId) {
            console.log("copyMessage response:", JSON.stringify(copied));
            await tgSendMessage(chatId, "⚠️ ফাইল পাঠানো যায়নি। পরে আবার চেষ্টা করো।");
            return new Response("ok", { status: 200 });
          }

          // ✅ IMPORTANT: caption replace possible ONLY if message supports caption
          const supportsCaption = captionSupportedKind(row.kind);

          const uploadedText = formatDhaka(row.uploaded_at);
          const link = deepLink(token);

          // set initial caption (so later we can "replace" it)
          if (supportsCaption) {
            const initCaption = buildInitialCaption({
              token,
              uploadedText,
              seconds: EXPIRE_SECONDS,
              link,
            });
            await tgEditCaption(chatId, userMessageId, initCaption);
          } else {
            // fallback: send a small note (sticker etc can't have caption)
            await tgSendMessage(chatId, `ℹ️ This message type can't show caption.\nLink: ${link}`);
          }

          // schedule PERFECT expire (edit caption after seconds)
          await scheduleExpire(env, {
            chatId: String(chatId),
            messageId: Number(userMessageId),
            token,
            uploadedText,
            seconds: EXPIRE_SECONDS,
            mode: supportsCaption ? "edit_caption" : "send_notice",
          });

          return new Response("ok", { status: 200 });
        }

        // ------------- upload: user sends file -------------
        const kind = detectKind(msg);
        if (!kind) {
          await tgSendMessage(chatId, "⚠️ শুধু ফাইল/ফটো/ভিডিও/ডকুমেন্ট পাঠাও—তারপর আমি link বানাবো।");
          return new Response("ok", { status: 200 });
        }

        // forward to channel (store)
        const fwd = await tgForwardMessage(TARGET_CHAT_ID, chatId, msg.message_id);
        const channelMessageId = fwd?.result?.message_id;

        if (!channelMessageId) {
          console.log("forwardMessage response:", JSON.stringify(fwd));
          await tgSendMessage(chatId, "⚠️ ফরওয়ার্ড হয়নি। আবার চেষ্টা করো।");
          return new Response("ok", { status: 200 });
        }

        const token = generateToken();
        const uploadedAtIso = new Date().toISOString();

        await env.DB.prepare(
          "INSERT INTO files (token, channel_chat_id, channel_message_id, kind, uploaded_at) VALUES (?, ?, ?, ?, ?)"
        )
          .bind(token, String(TARGET_CHAT_ID), Number(channelMessageId), String(kind), uploadedAtIso)
          .run();

        await tgSendMessage(chatId, `✅ Link created:\n${deepLink(token)}`);

        return new Response("ok", { status: 200 });
      } catch (e) {
        console.log("Webhook error:", e?.stack || e?.message || String(e));
        return new Response("ok", { status: 200 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
};

/**
 * DURABLE OBJECT (Perfect timing)
 */
export class ExpireCaptionScheduler {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/enqueue") {
      const job = await request.json();
      // job: { chatId, messageId, runAtMs, token, uploadedText, seconds, mode }
      await this.state.storage.put("job", job);
      await this.state.storage.setAlarm(job.runAtMs);
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  }

  async alarm() {
    const job = await this.state.storage.get("job");
    if (!job) return;

    try {
      const link = deepLink(job.token);

      if (job.mode === "edit_caption") {
        const expiredCaption = buildExpiredCaption({
          token: job.token,
          uploadedText: job.uploadedText,
          link,
        });
        await tgEditCaption(job.chatId, job.messageId, expiredCaption);
      } else {
        // fallback if caption not possible
        await tgSendMessage(job.chatId, `⚠️ Expired.\nUploaded: ${job.uploadedText}\nLink: ${link}`);
      }
    } catch (e) {
      console.log("Alarm error:", e?.stack || e?.message || String(e));
    } finally {
      await this.state.storage.delete("job");
    }
  }
}

/**
 * Schedule DO alarm
 */
async function scheduleExpire(env, job) {
  const id = env.DEL.idFromName(`${job.chatId}:${job.messageId}`);
  const stub = env.DEL.get(id);

  const runAtMs = Date.now() + job.seconds * 1000;

  await stub.fetch("https://do/enqueue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...job, runAtMs }),
  });
}

/**
 * Captions
 */
function buildInitialCaption({ token, uploadedText, seconds, link }) {
  const short = token.slice(0, 10);
  return [
    `📦 Uploaded: ${uploadedText}`,
    `🆔 File: ${short}`,
    `⏳ Auto-expire in ${seconds}s`,
    `🔗 ${link}`,
  ].join("\n");
}

function buildExpiredCaption({ token, uploadedText, link }) {
  const short = token.slice(0, 10);
  return [
    "⚠️ টেলিগ্রামের কপিরাইট/নিরাপত্তা নীতির কারণে এই ফাইলটি আর উপলব্ধ নয়।",
    "",
    `📦 Uploaded: ${uploadedText}`,
    `🆔 File: ${short}`,
    "🔁 পুনরায় ফাইল পেতে নিচের লিংক ব্যবহার করুন:",
    `🔗 ${link}`,
  ].join("\n");
}

function deepLink(token) {
  return `https://t.me/${BOT_USERNAME}?start=${token}`;
}

/**
 * Detect kind from user message
 */
function detectKind(msg) {
  if (msg.document) return "document";
  if (msg.photo) return "photo";
  if (msg.video) return "video";
  if (msg.animation) return "animation";
  if (msg.audio) return "audio";
  if (msg.voice) return "voice";
  // sticker has no caption support; optional:
  if (msg.sticker) return "sticker";
  return null;
}

function captionSupportedKind(kind) {
  // sticker doesn't support caption
  return kind !== "sticker";
}

/**
 * Time formatting (Bangladesh)
 */
function formatDhaka(iso) {
  try {
    const dt = new Date(iso);
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    return fmt.format(dt);
  } catch {
    return iso;
  }
}

/**
 * Token helpers
 */
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

/**
 * Telegram helpers
 */
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
      // protect_content: true, // চাইলে অন করো
    }),
  });
  const out = await res.text();
  if (!res.ok) console.log("copyMessage failed:", out);
  try { return JSON.parse(out); } catch { return { raw: out }; }
}

async function tgEditCaption(chatId, messageId, caption) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageCaption`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: Number(messageId),
      caption,
    }),
  });
  const out = await res.text();
  if (!res.ok) console.log("editMessageCaption failed:", out);
  try { return JSON.parse(out); } catch { return { raw: out }; }
}
