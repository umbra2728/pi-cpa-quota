# pi-cpa-quota

[Pi](https://pi.dev) extension that shows Codex and Claude subscription quota from a [cpa-quota-api](https://github.com/umbra2728/cpa-quota-api) server, the read-only quota companion for [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).

```text
Codex: 97% │ Claude: 67%
```

`/quota` opens an overlay with every account, quota window, reset time, observation age, routing availability and refresh state (`j`/`k`, PgUp/PgDn to scroll, `r` to refresh, `q`/Esc to close).

## Install

```bash
pi install npm:pi-cpa-quota
```

Create `~/.pi/agent/cpa-quota.json`:

```json
{
  "url": "https://your-gateway.example.com/v1/quota",
  "apiKey": "$CPA_API_KEY"
}
```

- `url` must be HTTPS (plain HTTP is allowed only for `localhost`/`127.0.0.1`), end in `/v1/quota`, and contain no credentials, query string or fragment.
- `apiKey` is your normal CLIProxyAPI client key. A `$NAME` reference is resolved from the Pi process environment first, then from `.env` next to the config file (normally `~/.pi/agent/.env`). The `.env` file is parsed as data; nothing is executed and the process environment is not modified. Missing, empty or unresolved keys fail closed.
- With `PI_CODING_AGENT_DIR` set, both files live in that directory instead. A legacy `quota-api.json` is read when `cpa-quota.json` does not exist.

Keep both files readable only by you (`chmod 600`). The key is sent only to the configured URL, redirects are refused, and server error bodies are never shown.

## Display

For each provider the value is the arithmetic mean of account-level minima: each account contributes its lowest known active window, so a constrained window is not hidden by a healthier one on the same account. Percentages are never summed across accounts.

A trailing `~` means stale, partial or error-affected data. Unknown data is shown as `—`, never as 0%.

The quota is refreshed every 5 minutes and on `r` in the overlay.

## Status bar placement

The extension publishes the status key `quota`. Pi's default footer shows it automatically. With [`pi-powerline-footer`](https://www.npmjs.com/package/pi-powerline-footer) you can pin it as a custom item in `~/.pi/agent/settings.json`:

```json
{
  "powerline": {
    "layout": { "right": ["cost", "context_pct", "custom:quota"] },
    "customItems": [
      { "id": "quota", "statusKey": "quota", "position": "right", "selfColorize": true, "excludeFromExtensionStatuses": true }
    ]
  }
}
```

## Development

```bash
npm ci
npm test
```

Releases are published to npm by CI on `v*` tags (`npm version patch && git push --follow-tags`).
