import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";

export async function uploadMultipartFile(uploadUrl, filePath, redirectsLeft = 5) {
  const file = await readFile(filePath);
  const boundary = `----VkBotBoundary${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const start = Buffer.from(
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="file"; filename="welcome.pdf"\r\n' +
    "Content-Type: application/pdf\r\n\r\n",
    "utf8",
  );
  const end = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const body = Buffer.concat([start, file, end]);

  return post(uploadUrl, body, boundary, redirectsLeft);
}

function post(uploadUrl, body, boundary, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const url = new URL(uploadUrl);
    const transport = url.protocol === "http:" ? http : https;
    const request = transport.request(url, {
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(body.length),
        "user-agent": "VK-Mailing-Bot/1.0",
        accept: "application/json",
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", async () => {
        const responseBody = Buffer.concat(chunks).toString("utf8");
        const location = response.headers.location;
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && location) {
          if (redirectsLeft <= 0) return reject(new Error("Слишком много перенаправлений upload-сервера ВК"));
          try {
            resolve(await post(new URL(location, url).toString(), body, boundary, redirectsLeft - 1));
          } catch (error) {
            reject(error);
          }
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Загрузка PDF HTTP ${response.statusCode}: ${responseBody.slice(0, 300)}`));
          return;
        }
        resolve(responseBody);
      });
    });
    request.setTimeout(60000, () => request.destroy(new Error("Тайм-аут загрузки PDF")));
    request.on("error", reject);
    request.end(body);
  });
}
