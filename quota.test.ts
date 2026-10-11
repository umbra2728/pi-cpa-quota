import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { average, parseSnapshot, stale, tone, type Window } from "./quota.ts";
import { QuotaOverlay, status, type State } from "./index.ts";
import { loadConfig, fetchQuota, type Config } from "./client.ts";

const now = Date.now();
const w = (remaining: number | null): Window => ({ label: "Weekly", group: "main", scope: "", remaining, reset: now + 1000_000, observed: now, freshness: "fresh", state: "allowed" });
const a = (n: number, windows: Window[]) => ({ id: `acct_${String(n).padStart(32, "0")}`, plan: "pro", available: true, refresh: "idle", windows });
const theme = { fg: (_: string, s: string) => s } as Theme;
const snapshot = { providers: [{ provider: "codex", accounts: [a(1, [w(97), w(80)]), a(2, [w(98), w(60)])] }, { provider: "claude", accounts: [a(3, [w(67)])] }], state: "available" };

test("equal account weighting after minimum across each account's windows", () => {
  assert.deepEqual(average(snapshot.providers[0].accounts, now, 900_000), { value: 70, known: 2, total: 2, uncertain: false });
  assert.equal(average([a(1, [w(0)]), a(2, [w(100)])], now, 900_000).value, 50);
});

test("unknown is excluded and explicitly marked partial, stale is retained", () => {
  assert.deepEqual(average([a(1, [w(40)]), a(2, [w(null)])], now, 900_000), { value: 40, known: 1, total: 2, uncertain: true });
  assert.equal(average([a(1, [{ ...w(90), freshness: "stale" }])], now, 900_000).uncertain, true);
  assert.equal(average([], now, 900_000).value, null);
  assert.equal(stale({ ...w(90), reset: now - 1 }, now, 900_000), true);
  assert.equal(stale(w(90), now + 900_000, 900_000), true);
});

test("thresholds use actual value, not rounded percentage", () => {
  assert.equal(tone(70), "success");
  assert.equal(tone(69.9), "warning");
  assert.equal(tone(30), "warning");
  assert.equal(tone(29.9), "error");
  assert.equal(tone(90, true), "dim");
});

test("parser rejects incompatible schema and strips terminal controls", () => {
  assert.throws(() => parseSnapshot({ schema_version: 2, providers: [] }));
  const raw = { schema_version: 1, shared_pool: true, snapshot_state: "available", providers: [{ provider: "codex", accounts: [{ account_id: a(1, []).id, windows: [{ label: "test\n\x1b[31m", remaining_percent: "99", observed_at: "invalid" }] }] }] };
  const parsed = parseSnapshot(raw);
  assert.equal(parsed.providers[0].accounts[0].windows[0].remaining, null);
  assert.equal(parsed.providers[0].accounts[0].windows[0].observed, null);
  assert.ok(!/[\n\x1b]/.test(parsed.providers[0].accounts[0].windows[0].label));
});

test("Powerline status separates providers and labels retained data", () => {
  const state: State = { snapshot, error: null, fetchedAt: now, loading: false };
  assert.equal(status(state, theme), "Codex: 70% │ Claude: 67%");
  assert.equal(status({ ...state, error: "offline" }, theme), "Codex: 70%~ │ Claude: 67%~");
});

test("overlay fits narrow terminals, scrolls all accounts and closes", () => {
  let closed = false;
  const state: State = { snapshot, error: null, fetchedAt: now, loading: false };
  const tui = { terminal: { rows: 24 }, requestRender: () => {} } as unknown as TUI;
  const overlay = new QuotaOverlay(tui, theme, () => { closed = true; }, () => state, async () => {});
  for (const width of [1, 20, 40, 80, 140]) {
    const lines = overlay.render(width);
    assert.ok(lines.length <= 20);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
  }
  for (let i = 0; i < 100; i++) overlay.handleInput("j");
  assert.ok(overlay.render(100).join("\n").includes("CLAUDE"));
  overlay.handleInput("q");
  assert.equal(closed, true);
});

test("config accepts only HTTPS (or loopback HTTP) /v1/quota URLs without embedded secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-quota-test-"));
  const path = join(dir, "config.json");
  try {
    for (const url of ["http://quota.example.com/v1/quota", "https://quota.example.com/v1/models", "https://quota.example.com/v1/quota?key=x", "https://quota.example.com/v1/quota#k", "https://user:secret@quota.example.com/v1/quota", "ftp://quota.example.com/v1/quota"]) {
      await writeFile(path, JSON.stringify({ url, apiKey: "test-key-only" }));
      await assert.rejects(loadConfig(path));
    }
    for (const url of ["https://quota.example.com/v1/quota", "https://gw.example.com/proxy/v1/quota", "http://127.0.0.1:8082/v1/quota", "http://localhost:8082/v1/quota"]) {
      await writeFile(path, JSON.stringify({ url, apiKey: "test-key-only" }));
      assert.equal((await loadConfig(path)).apiKey, "test-key-only");
    }
  } finally { await rm(dir, { recursive: true }); }
});

test("environment references use process env before adjacent dotenv and fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-quota-env-"));
  const path = join(dir, "config.json");
  const name = "PI_QUOTA_TEST_ONLY_KEY";
  const previous = process.env[name];
  try {
    delete process.env[name];
    await writeFile(path, JSON.stringify({ url: "https://quota.example.com/v1/quota", apiKey: `$${name}` }));
    await assert.rejects(loadConfig(path));
    await writeFile(join(dir, ".env"), `export ${name}="dotenv-test-key"\n`);
    assert.equal((await loadConfig(path)).apiKey, "dotenv-test-key");
    assert.equal(process.env[name], undefined);
    process.env[name] = "process-test-key";
    assert.equal((await loadConfig(path)).apiKey, "process-test-key");
    process.env[name] = "";
    await assert.rejects(loadConfig(path));
    delete process.env[name];
    await writeFile(join(dir, ".env"), "UNRELATED=value\n");
    await assert.rejects(loadConfig(path));
    await writeFile(join(dir, ".env"), `${name}="$UNRESOLVED"\n`);
    await assert.rejects(loadConfig(path));
  } finally {
    if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
    await rm(dir, { recursive: true });
  }
});

test("HTTP errors never surface server bodies or secrets", async () => {
  const original = globalThis.fetch;
  const cfg: Config = { url: "https://quota.example.com/v1/quota", apiKey: "test-key-only" };
  try {
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      assert.equal(init.redirect, "error");
      return new Response("sensitive body", { status: 401 });
    }) as typeof fetch;
    await assert.rejects(fetchQuota(cfg, new AbortController().signal), { message: "Quota API key rejected" });
    globalThis.fetch = (async () => new Response("not JSON", { headers: { "content-type": "application/json" } })) as typeof fetch;
    await assert.rejects(fetchQuota(cfg, new AbortController().signal), { message: "Quota API returned invalid data" });
  } finally { globalThis.fetch = original; }
});
