import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { parseSnapshot, type Snapshot } from "./quota.ts";

export type Config = { url: string; apiKey: string };
const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);

function validUrl(url: URL): boolean {
  const secure = url.protocol === "https:" || (url.protocol === "http:" && loopback.has(url.hostname));
  return secure && !url.username && !url.password && !url.search && !url.hash && url.pathname.endsWith("/v1/quota");
}

export async function loadConfig(path: string): Promise<Config> {
  try {
    const cfg = JSON.parse(await readFile(path, "utf8"));
    if (!cfg || typeof cfg.url !== "string" || typeof cfg.apiKey !== "string") throw new Error();
    let apiKey = cfg.apiKey.trim();
    if (apiKey.startsWith("$")) {
      const reference = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(apiKey);
      if (!reference) throw new Error();
      const name = reference[1];
      apiKey = process.env[name] ?? parseEnv(await readFile(join(dirname(path), ".env"), "utf8"))[name];
    }
    if (typeof apiKey !== "string" || apiKey.trim().length < 8 || /[\r\n]/.test(apiKey) || apiKey.trim().startsWith("$")) throw new Error();
    const url = new URL(cfg.url);
    if (!validUrl(url)) throw new Error();
    return { url: url.href, apiKey: apiKey.trim() };
  } catch {
    throw new Error("Set url and apiKey in ~/.pi/agent/cpa-quota.json (HTTPS URL ending in /v1/quota)");
  }
}


export async function fetchQuota(cfg: Config, signal: AbortSignal): Promise<Snapshot> {
  const response = await fetch(cfg.url, {
    method: "GET", redirect: "error", signal,
    headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: "application/json" },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(response.status === 401 || response.status === 403 ? "Quota API key rejected" : `Quota API unavailable (HTTP ${response.status})`);
  }
  if (!response.headers.get("content-type")?.includes("application/json") || !response.body) {
    await response.body?.cancel();
    throw new Error("Quota API returned invalid data");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 2_000_000) throw new Error("Quota response too large");
      chunks.push(value);
    }
    return parseSnapshot(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error("Quota API returned invalid data");
  } finally {
    reader.releaseLock();
  }
}

