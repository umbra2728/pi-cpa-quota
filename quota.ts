export type Window = {
  label: string;
  group: string;
  scope: string;
  remaining: number | null;
  reset: number | null;
  observed: number | null;
  freshness: string;
  state: string;
};
export type Account = {
  id: string;
  plan: string;
  available: boolean | null;
  refresh: string;
  windows: Window[];
};
export type Snapshot = { providers: { provider: string; accounts: Account[] }[]; state: string };
export type Average = { value: number | null; known: number; total: number; uncertain: boolean };

const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
export const text = (v: unknown) => typeof v === "string" ? v.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, 120) : "";
const date = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
const percent = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;

export function parseSnapshot(value: unknown): Snapshot {
  const root = object(value);
  if (root.schema_version !== 1 || root.shared_pool !== true || !Array.isArray(root.providers)) throw new Error("Unsupported quota response");
  const providers = ["codex", "claude"].map(provider => {
    const rows = (root.providers as unknown[]).map(object).filter(p => p.provider === provider);
    const accounts = new Map<string, Account>();
    for (const row of rows) {
      if (!Array.isArray(row.accounts) || row.accounts.length > 1000) throw new Error("Invalid account list");
      for (const raw of row.accounts) {
        const a = object(raw);
        if (typeof a.account_id !== "string" || !/^acct_[a-f0-9]{32}$/.test(a.account_id)) throw new Error("Invalid account identifier");
        if (!Array.isArray(a.windows) || a.windows.length > 200) throw new Error("Invalid quota windows");
        const routing = object(a.routing);
        accounts.set(a.account_id, {
          id: a.account_id,
          plan: text(a.plan),
          available: typeof routing.available === "boolean" ? routing.available : null,
          refresh: text(object(a.refresh).state),
          windows: a.windows.map(rawWindow => {
            const w = object(rawWindow);
            return {
              label: text(w.label) || text(w.key) || "Unknown window",
              group: text(w.group), scope: text(w.scope),
              remaining: percent(w.remaining_percent), reset: date(w.reset_at), observed: date(w.observed_at),
              freshness: text(w.freshness), state: text(w.state),
            };
          }),
        });
      }
    }
    return { provider, accounts: [...accounts.values()].sort((a, b) => a.id.localeCompare(b.id)) };
  });
  return { providers, state: text(root.snapshot_state) };
}

export function stale(w: Window, now: number, staleAfterMs: number): boolean {
  return w.freshness !== "fresh" || w.observed === null || w.observed > now + 60_000 || now - w.observed >= staleAfterMs || (w.reset !== null && now >= w.reset);
}

export function average(accounts: Account[], now: number, staleAfterMs: number): Average {
  const values: number[] = [];
  let uncertain = false;
  for (const a of accounts) {
    const known = a.windows.filter(w => w.remaining !== null && w.freshness !== "unknown" && w.observed !== null);
    if (known.length) values.push(Math.min(...known.map(w => w.remaining!)));
    if (!known.length || known.length !== a.windows.length || a.windows.some(w => stale(w, now, staleAfterMs))) uncertain = true;
  }
  return { value: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, known: values.length, total: accounts.length, uncertain };
}

export function tone(value: number | null, uncertain = false): "dim" | "success" | "warning" | "error" {
  return uncertain || value === null ? "dim" : value >= 70 ? "success" : value >= 30 ? "warning" : "error";
}

export function duration(ms: number): string {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}m`;
}
