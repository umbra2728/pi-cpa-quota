import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { average, duration, stale, tone, type Snapshot } from "./quota.ts";
import { loadConfig, fetchQuota, type Config } from "./client.ts";

export type State = { snapshot: Snapshot | null; error: string | null; fetchedAt: number | null; loading: boolean };
const agentDir = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const configPath = () => {
  const current = join(agentDir(), "cpa-quota.json");
  const legacy = join(agentDir(), "quota-api.json");
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
};
const staleAfterMs = 900_000;

export function status(state: State, theme: Theme): string {
  if (!state.snapshot && state.error?.startsWith("Set url")) return theme.fg("dim", "Codex: — │ Claude: —");
  return ["codex", "claude"].map(provider => {
    const accounts = state.snapshot?.providers.find(p => p.provider === provider)?.accounts ?? [];
    const result = average(accounts, Date.now(), staleAfterMs);
    const uncertain = result.uncertain || !!state.error || state.snapshot?.state === "stale" || state.snapshot?.state === "unknown";
    const value = result.value === null ? "—" : `${Math.round(result.value)}%${uncertain ? "~" : ""}`;
    return theme.fg(tone(result.value, uncertain), `${provider === "codex" ? "Codex" : "Claude"}: ${value}`);
  }).join(theme.fg("dim", " │ "));
}

export class QuotaOverlay implements Component {
  private offset = 0;
  private bodyHeight = 1;
  private bodyLength = 0;
  private closed = false;
  constructor(private readonly tui: TUI, private readonly theme: Theme, private readonly done: () => void, private readonly getState: () => State, private readonly refresh: () => Promise<void>) {}
  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) { this.closed = true; this.done(); return; }
    if (matchesKey(data, "r") && !this.getState().loading) void this.refresh().then(() => { if (!this.closed) this.tui.requestRender(); });
    if (matchesKey(data, "down") || data === "j") this.offset++;
    if (matchesKey(data, "up") || data === "k") this.offset--;
    if (matchesKey(data, "pageDown")) this.offset += this.bodyHeight;
    if (matchesKey(data, "pageUp")) this.offset -= this.bodyHeight;
    this.offset = Math.max(0, Math.min(this.offset, this.bodyLength - this.bodyHeight));
    this.tui.requestRender();
  }
  render(width: number): string[] {
    const state = this.getState();
    const now = Date.now();
    const th = this.theme;
    const inner = Math.max(0, width - 2);
    const rows = Math.max(1, this.tui.terminal.rows - 4);
    this.bodyHeight = Math.max(1, Math.min(32, rows) - 6);
    const body: string[] = [];
    if (state.error) body.push(th.fg("warning", state.error));
    if (!state.snapshot) body.push(th.fg("dim", "No data. Edit cpa-quota.json, then press r."));
    for (const provider of ["codex", "claude"]) {
      const accounts = state.snapshot?.providers.find(p => p.provider === provider)?.accounts ?? [];
      const result = average(accounts, now, staleAfterMs);
      body.push(th.fg("accent", `${provider.toUpperCase()}  ${result.known}/${result.total} accounts with data`));
      for (const a of accounts) {
        const route = a.available === true ? th.fg("success", "● ready") : a.available === false ? th.fg("error", "● unavailable") : th.fg("dim", "○ routing unknown");
        body.push(`  ${th.fg("text", a.id.slice(5, 13))} ${th.fg("muted", a.plan)}  ${route}`);
        if (!a.windows.length) body.push(th.fg("dim", "    No quota observations"));
        for (const w of a.windows) {
          const old = stale(w, now, staleAfterMs) || !!state.error;
          const value = w.remaining === null ? "unknown" : `${Math.round(w.remaining)}% left`;
          const count = Math.round((w.remaining ?? 0) / 10);
          const bar = w.remaining === null ? "░".repeat(10) : "━".repeat(count) + "─".repeat(10 - count);
          const reset = w.reset === null ? "reset unknown" : w.reset <= now ? "reset passed · unconfirmed" : `reset in ${duration(w.reset - now)}`;
          const observed = w.observed === null ? "unknown age" : `observed ${duration(now - w.observed)} ago`;
          body.push(`    ${th.fg("text", w.label)}${w.scope ? th.fg("dim", ` · ${w.scope}`) : ""}`);
          body.push(`    ${th.fg(tone(w.remaining, old), `${bar} ${value}`)}  ${th.fg("muted", reset)}`);
          body.push(th.fg("dim", `    ${observed} · ${old ? "stale" : w.freshness} · ${w.group || "quota"}`));
        }
        if (a.refresh) body.push(th.fg("dim", `    refresh: ${a.refresh}`));
        body.push("");
      }
      if (!accounts.length) body.push(th.fg("dim", "  No accounts"), "");
    }
    this.bodyLength = body.length;
    this.offset = Math.max(0, Math.min(this.offset, body.length - this.bodyHeight));
    const boxLine = (value: string) => {
      const clipped = truncateToWidth(` ${value}`, inner, "…");
      return th.fg("accent", "│") + clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped))) + th.fg("accent", "│");
    };
    const fetched = state.fetchedAt === null ? "not fetched" : `fetched ${duration(now - state.fetchedAt)} ago`;
    const lines = [
      th.fg("accent", `╭${"─".repeat(inner)}╮`),
      boxLine(th.fg("accent", `Quota · shared pool${state.loading ? " · refreshing…" : ""}`)),
      boxLine(th.fg("dim", "Mean of account minima · not total pool capacity")),
      ...body.slice(this.offset, this.offset + this.bodyHeight).map(boxLine),
      boxLine(th.fg("dim", `${fetched} · ${this.offset + 1}–${Math.min(body.length, this.offset + this.bodyHeight)}/${body.length}`)),
      boxLine(th.fg("muted", "↑↓/j k scroll · PgUp/PgDn · r refresh · Esc close")),
      th.fg("accent", `╰${"─".repeat(inner)}╯`),
    ];
    return lines.slice(0, rows).map(value => truncateToWidth(value, width));
  }
  invalidate(): void {}
  dispose(): void { this.closed = true; }
}

export default function quotaExtension(pi: ExtensionAPI) {
  let state: State = { snapshot: null, error: null, fetchedAt: null, loading: false };
  let timer: ReturnType<typeof setInterval> | undefined;
  let repaint: ReturnType<typeof setInterval> | undefined;
  let active: ExtensionContext | undefined;
  let generation = 0;
  let controller: AbortController | undefined;
  let configIdentity = "";
  let lastAttempt = 0;
  let redraw: (() => void) | undefined;
  const publish = () => {
    if (!active) return;
    active.ui.setStatus("quota", status(state, active.ui.theme));
    redraw?.();
  };
  const refresh = async () => {
    if (!active || state.loading || Date.now() - lastAttempt < 10_000) return;
    const current = generation;
    lastAttempt = Date.now();
    state.loading = true;
    publish();
    const abort = new AbortController();
    controller = abort;
    const timeout = setTimeout(() => abort.abort(), 12_000);
    try {
      const cfg: Config = await loadConfig(configPath());
      const identity = cfg.url + "\n" + cfg.apiKey;
      if (current !== generation) return;
      if (identity !== configIdentity) { state.snapshot = null; state.fetchedAt = null; configIdentity = identity; }
      const snapshot = await fetchQuota(cfg, abort.signal);
      if (current !== generation) return;
      state.snapshot = snapshot;
      state.fetchedAt = Date.now();
      state.error = null;
    } catch (error) {
      if (current !== generation) return;
      const message = error instanceof Error ? error.message : "";
      if (message.startsWith("Set url") || message === "Quota API key rejected") { state.snapshot = null; state.fetchedAt = null; }
      state.error = message.startsWith("Set url") || message.startsWith("Quota API") ? message : "Quota API unavailable; last observation retained";
    } finally {
      clearTimeout(timeout);
      if (current === generation) { controller = undefined; state.loading = false; publish(); }
    }
  };
  const stop = () => {
    generation++;
    controller?.abort();
    controller = undefined;
    clearInterval(timer);
    clearInterval(repaint);
    timer = repaint = undefined;
    active?.ui.setStatus("quota", undefined);
    active = undefined;
    redraw = undefined;
    state.loading = false;
  };
  pi.on("session_start", (_event, ctx) => {
    stop();
    if (ctx.mode !== "tui") return;
    active = ctx;
    publish();
    void refresh();
    timer = setInterval(() => void refresh(), 300_000);
    repaint = setInterval(publish, 30_000);
  });
  pi.on("session_shutdown", stop);
  pi.registerCommand("quota", {
    description: "Quota by account and window · shared Codex / Claude pool",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") { if (ctx.hasUI) ctx.ui.notify("/quota requires interactive Pi", "info"); return; }
      active = ctx;
      void refresh();
      try {
        await ctx.ui.custom<void>((tui, theme, _keys, done) => {
          redraw = () => tui.requestRender();
          return new QuotaOverlay(tui, theme, done, () => state, refresh);
        }, { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%" } });
      } finally { redraw = undefined; }
    },
  });
}
