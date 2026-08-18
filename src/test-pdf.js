import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { uploadMultipartFile } from "./multipart.js";

const env = await readFile(resolve(".env"), "utf8");
for (const rawLine of env.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  const separator = line.indexOf("=");
  if (separator < 1) continue;
  const key = line.slice(0, separator).trim();
  let value = line.slice(separator + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  process.env[key] ??= value;
}

const token = process.env.VK_TOKEN;
const version = process.env.VK_API_VERSION || "5.199";
const groupId = Number(process.env.VK_GROUP_ID);
const subscribers = JSON.parse(await readFile(resolve("data", "subscribers.json"), "utf8"));
const peerId = Number(subscribers.subscribers?.[0]);
if (!peerId) throw new Error("Нет подписчика для тестовой отправки");

async function api(method, params) {
  const body = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])),
    access_token: token,
    v: version,
  });
  const response = await fetch(`https://api.vk.com/method/${method}`, { method: "POST", body });
  const data = await response.json();
  if (data.error) throw new Error(`${method}: [${data.error.error_code}] ${data.error.error_msg}`);
  return data.response;
}

if (process.env.VK_PDF_ATTACHMENT?.trim()) {
  console.log("Отправляю заранее загруженный PDF");
  await api("messages.send", {
    peer_id: peerId,
    random_id: Math.floor(Math.random() * 2_147_483_647) + 1,
    message: "Готово! Приветственный PDF теперь подключён постоянно ✅",
    attachment: process.env.VK_PDF_ATTACHMENT.trim(),
  });
  console.log(`УСПЕХ attachment=${process.env.VK_PDF_ATTACHMENT.trim()}`);
  process.exit(0);
}

console.log(`0/4 Включаю раздел документов сообщества в ограниченном режиме`);
await api("groups.edit", { group_id: groupId, docs: 2 });
console.log(`1/4 Получаю сервер загрузки документов сообщества ${groupId}`);
const server = await api("docs.getWallUploadServer", { group_id: groupId });
const safeUploadUrl = new URL(server.upload_url);
console.log(`Upload endpoint: ${safeUploadUrl.origin}${safeUploadUrl.pathname}, params=${[...safeUploadUrl.searchParams.keys()].join(",")}`);

console.log("2/4 Загружаю PDF");
const uploadText = await uploadMultipartFile(server.upload_url, resolve("output", "pdf", "welcome.pdf"));
const uploaded = JSON.parse(uploadText);
if (!uploaded.file) throw new Error(`Upload server: ${JSON.stringify(uploaded)}`);

console.log("3/4 Сохраняю документ");
const saved = await api("docs.save", { file: uploaded.file, title: "Добро пожаловать", tags: "сообщество, рассылка" });
const document = saved?.doc || saved?.[0]?.doc || saved?.[0] || saved;
if (!document?.owner_id || !document?.id) throw new Error(`docs.save: ${JSON.stringify(saved)}`);
const attachment = `doc${document.owner_id}_${document.id}${document.access_key ? `_${document.access_key}` : ""}`;

console.log("4/4 Отправляю тестовое сообщение");
await api("messages.send", {
  peer_id: peerId,
  random_id: Math.floor(Math.random() * 2_147_483_647) + 1,
  message: "Готово! Это тестовая отправка приветственного PDF ✅",
  attachment,
});
console.log(`УСПЕХ attachment=${attachment}`);
