import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const contents = await readFile(resolve(".env"), "utf8");
for (const rawLine of contents.split(/\r?\n/)) {
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
const groupId = process.env.VK_GROUP_ID;
const version = process.env.VK_API_VERSION || "5.199";

async function check(label, method, params = {}) {
  const body = new URLSearchParams({ ...params, access_token: token, v: version });
  try {
    const response = await fetch(`https://api.vk.com/method/${method}`, { method: "POST", body });
    const data = await response.json();
    if (data.error) {
      console.log(`${label}: ОШИБКА [${data.error.error_code}] ${data.error.error_msg}`);
      return;
    }
    if (method === "groups.getById") {
      const group = data.response?.groups?.[0] || data.response?.[0];
      console.log(`${label}: OK, id=${group?.id}, name=${group?.name}`);
      return;
    }
    if (method === "groups.getTokenPermissions") {
      console.log(`${label}: OK, mask=${data.response?.mask ?? "неизвестно"}, permissions=${(data.response?.permissions || []).join(",") || "неизвестно"}`);
      return;
    }
    console.log(`${label}: OK`);
  } catch (error) {
    console.log(`${label}: СБОЙ ${error.message}`);
  }
}

await check("Токен и ID сообщества", "groups.getById", { group_ids: groupId });
await check("Сообщество, которому принадлежит токен", "groups.getById");
await check("Права токена", "groups.getTokenPermissions");
await check("Настройки Long Poll", "groups.getLongPollSettings", { group_id: groupId });
await check("Сервер Long Poll", "groups.getLongPollServer", { group_id: groupId });
