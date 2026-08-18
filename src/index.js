import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { uploadMultipartFile } from "./multipart.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(rootDir, ".env");
const subscribersPath = resolve(rootDir, "data", "subscribers.json");
const welcomePdfPath = resolve(rootDir, "output", "pdf", "welcome.pdf");

await loadEnv(envPath);

const token = requiredEnv("VK_TOKEN");
const groupId = Number(requiredEnv("VK_GROUP_ID"));
const apiVersion = process.env.VK_API_VERSION || "5.199";
const adminIds = new Set(
  requiredEnv("ADMIN_IDS")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter(Number.isSafeInteger),
);

if (!Number.isSafeInteger(groupId) || groupId <= 0) {
  throw new Error("VK_GROUP_ID должен быть положительным числом");
}
if (adminIds.size === 0) {
  throw new Error("В ADMIN_IDS должен быть хотя бы один числовой VK ID");
}

const subscribers = await loadSubscribers();
let welcomeAttachment = process.env.VK_PDF_ATTACHMENT?.trim() || "";
let welcomeAttachmentPromise = null;
let stopping = false;

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

console.log(`Бот запущен. Подписчиков: ${subscribers.size}. Для остановки нажмите Ctrl+C.`);

while (!stopping) {
  try {
    await runLongPoll();
  } catch (error) {
    console.error("Long Poll прерван:", error.message);
    if (!stopping) await delay(3000);
  }
}

async function runLongPoll() {
  const server = await vkApi("groups.getLongPollServer", { group_id: groupId });
  let ts = server.ts;

  while (!stopping) {
    const url = new URL(server.server);
    url.searchParams.set("act", "a_check");
    url.searchParams.set("key", server.key);
    url.searchParams.set("ts", ts);
    url.searchParams.set("wait", "25");

    const response = await fetch(url, { signal: AbortSignal.timeout(35000) });
    if (!response.ok) throw new Error(`Long Poll HTTP ${response.status}`);
    const result = await response.json();

    if (result.failed) {
      if (result.failed === 1 && result.ts) {
        ts = result.ts;
        continue;
      }
      throw new Error(`Long Poll error ${result.failed}`);
    }

    ts = result.ts;
    for (const update of result.updates || []) {
      try {
        await handleUpdate(update);
      } catch (error) {
        console.error(`Ошибка обработки ${update.type}:`, error.message);
      }
    }
  }
}

async function handleUpdate(update) {
  if (Number(update.group_id) !== groupId) return;

  if (update.type === "group_join") {
    const userId = Number(update.object?.user_id);
    if (!Number.isSafeInteger(userId)) return;
    try {
      await sendWelcomePdf(userId, "Спасибо, что подписались на наше сообщество! Забирайте приветственный PDF 🎁");
    } catch (error) {
      console.warn(`Не удалось отправить PDF новому участнику ${userId}: ${error.message}. Вероятно, сообщения сообщества ещё не разрешены.`);
    }
    return;
  }

  if (update.type === "message_deny") {
    const userId = Number(update.object?.user_id);
    if (subscribers.delete(userId)) await saveSubscribers();
    return;
  }

  if (update.type !== "message_new") return;
  const message = update.object?.message;
  if (!message || message.out !== 0 || message.peer_id !== message.from_id) return;

  const userId = Number(message.from_id);
  const text = String(message.text || "").trim();
  const command = text.toLocaleLowerCase("ru-RU");

  if (["начать", "старт", "подписаться"].includes(command)) {
    const wasAdded = !subscribers.has(userId);
    subscribers.add(userId);
    if (wasAdded) await saveSubscribers();
    const reply = wasAdded
      ? "Вы подписались на рассылку ✅\nЧтобы отказаться, напишите «Отписаться»."
      : "Вы уже подписаны ✅";
    try {
      await sendWelcomePdf(userId, reply);
    } catch (error) {
      console.error(`Не удалось приложить PDF для ${userId}:`, error.message);
      await sendMessage(userId, `${reply}\n\nPDF временно не прикрепился, но подписка сохранена.`);
    }
    return;
  }

  if (["отписаться", "стоп"].includes(command)) {
    const wasSubscribed = subscribers.delete(userId);
    if (wasSubscribed) await saveSubscribers();
    await sendMessage(userId, wasSubscribed
      ? "Вы отписались от рассылки. Больше сообщений не будет."
      : "Вы не были подписаны на рассылку.");
    return;
  }

  if (command === "помощь" || command === "help") {
    await sendMessage(userId, helpText(adminIds.has(userId)));
    return;
  }

  if (adminIds.has(userId) && command === "статистика") {
    await sendMessage(userId, `Активных подписчиков: ${subscribers.size}`);
    return;
  }

  const mailingMatch = text.match(/^рассылка(?:\s+|\n)([\s\S]+)/i);
  if (adminIds.has(userId) && mailingMatch) {
    await broadcast(userId, mailingMatch[1].trim());
    return;
  }

  await sendMessage(userId, helpText(adminIds.has(userId)));
}

async function broadcast(adminId, mailingText) {
  if (!mailingText) {
    await sendMessage(adminId, "После команды «Рассылка» добавьте текст сообщения.");
    return;
  }

  const recipients = [...subscribers];
  await sendMessage(adminId, `Начинаю рассылку для ${recipients.length} подписчиков.`);
  let sent = 0;
  let failed = 0;

  for (const userId of recipients) {
    try {
      await sendMessage(userId, mailingText);
      sent += 1;
    } catch (error) {
      failed += 1;
      console.error(`Не отправлено пользователю ${userId}:`, error.message);
      if (/\[(901|902)\]/.test(error.message)) subscribers.delete(userId);
    }
    await delay(50);
  }

  await saveSubscribers();
  await sendMessage(adminId, `Рассылка завершена. Доставлено: ${sent}, ошибок: ${failed}.`);
}

function helpText(isAdmin) {
  let text = "Команды:\nПодписаться — получать рассылку\nОтписаться — отказаться от рассылки";
  if (isAdmin) text += "\n\nДля администратора:\nСтатистика\nРассылка Текст сообщения";
  return text;
}

async function sendWelcomePdf(peerId, message) {
  const attachment = await getWelcomeAttachment(peerId);
  return sendMessage(peerId, message, attachment);
}

async function sendMessage(peerId, message, attachment = "") {
  return vkApi("messages.send", {
    peer_id: peerId,
    message,
    ...(attachment ? { attachment } : {}),
    random_id: randomInt32(),
  });
}

async function getWelcomeAttachment(peerId) {
  if (welcomeAttachment) return welcomeAttachment;
  if (!welcomeAttachmentPromise) {
    welcomeAttachmentPromise = uploadWelcomePdf(peerId)
      .then((attachment) => {
        welcomeAttachment = attachment;
        return attachment;
      })
      .finally(() => {
        welcomeAttachmentPromise = null;
      });
  }
  return welcomeAttachmentPromise;
}

async function uploadWelcomePdf(peerId) {
  const uploadServer = await vkApi("docs.getMessagesUploadServer", {
    peer_id: peerId,
    type: "doc",
  });

  const uploadText = await uploadMultipartFile(uploadServer.upload_url, welcomePdfPath);
  let uploadResult;
  try {
    uploadResult = JSON.parse(uploadText);
  } catch {
    throw new Error(`Сервер загрузки ВК вернул не JSON: ${uploadText.slice(0, 300)}`);
  }
  if (!uploadResult.file) {
    throw new Error(`ВК не вернул идентификатор загруженного PDF: ${JSON.stringify(uploadResult).slice(0, 500)}`);
  }

  const saved = await vkApi("docs.save", {
    file: uploadResult.file,
    title: "Добро пожаловать",
    tags: "сообщество, рассылка",
  });
  const document = saved?.doc || saved?.[0]?.doc || saved?.[0] || saved;
  if (!document?.owner_id || !document?.id) throw new Error("ВК не вернул данные сохранённого PDF");

  const accessKey = document.access_key ? `_${document.access_key}` : "";
  const attachment = `doc${document.owner_id}_${document.id}${accessKey}`;
  console.log(`Приветственный PDF загружен в ВК: ${attachment}`);
  return attachment;
}

async function vkApi(method, params) {
  const body = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])),
    access_token: token,
    v: apiVersion,
  });
  const response = await fetch(`https://api.vk.com/method/${method}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`VK API HTTP ${response.status}`);
  const data = await response.json();
  if (data.error) {
    throw new Error(`[${data.error.error_code}] ${data.error.error_msg}`);
  }
  return data.response;
}

async function loadSubscribers() {
  try {
    const data = JSON.parse(await readFile(subscribersPath, "utf8"));
    return new Set((data.subscribers || []).map(Number).filter(Number.isSafeInteger));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return new Set();
  }
}

async function saveSubscribers() {
  await mkdir(dirname(subscribersPath), { recursive: true });
  const tempPath = `${subscribersPath}.tmp`;
  const data = JSON.stringify({ subscribers: [...subscribers], updatedAt: new Date().toISOString() }, null, 2);
  await writeFile(tempPath, `${data}\n`, "utf8");
  await rename(tempPath, subscribersPath);
}

async function loadEnv(path) {
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      if (process.env.VK_TOKEN && process.env.VK_GROUP_ID && process.env.ADMIN_IDS) return;
      throw new Error("Не найден файл .env и не заданы переменные окружения VK_TOKEN, VK_GROUP_ID, ADMIN_IDS.");
    }
    throw error;
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Не заполнена настройка ${name} в файле .env`);
  return value;
}

function randomInt32() {
  return Math.floor(Math.random() * 2_147_483_647) + 1;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function stop() {
  stopping = true;
  console.log("Останавливаю бота…");
}
