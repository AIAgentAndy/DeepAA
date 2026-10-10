# DeepAA

**Understand AI costs. Trace every call.**

DeepAA (Deep Agent Analytics) is an open source, local workspace for **AI coding cost transparency and multi-model management**. It connects official prices, plans, subscriptions, relay multipliers, and promotions to individual requests, so you can inspect usage, costs, and calculation details. Manage providers and agents, trace inputs and outputs, and configure model-level failover in the same workspace.

[Website & product preview](https://deepaa.dev/en-US) · [Installation & setup](https://deepaa.dev/en-US/docs) · [中文文档](./README_cn.md) · [MIT license](./LICENSE)

## Core Value

With multiple agents, models, and providers, a bill total rarely explains which task incurred a cost or why. Cache rates, plan quotas, subscription windows, relay multipliers, and promotions make comparisons harder. DeepAA brings these rules, request records, and configuration controls into one local workspace.

| Capability | What you get |
| --- | --- |
| **Per-request cost transparency** | Inspect uncached input, cache reads, cache writes, and output charges, with matched rates, multipliers, settlement coefficients, plan usage rules, and calculation formulas. Compare totals by model, provider, agent, and time range. |
| **Unified provider and agent access** | Check connected provider balances and plan quotas; manage models and credentials. Enable CLI sync to avoid editing managed settings by hand and use compatible models from multiple providers in the same agent. |
| **Agent-to-model call tracing** | Follow Session → Thread → Turn → Step relationships across tasks and sub-agents. Inspect prompts, model outputs, tool interactions, tokens, latency, and request evidence together. |
| **Model and billing-rule update notifications** | Follow the published model catalog for new models and changes to prices, plans, promotions, and capabilities. Inspect versions, before/after differences, and which models you currently use are affected. |
| **Model-level failover** | Configure ordered model-and-provider backups, failure thresholds, sticky backup selection, and recovery probes to reduce disruption from model or channel failures. |

Observability records stay on your machine, with no upload to a DeepAA cloud. Model requests still go to your chosen provider. No agent source changes or observability SDK are required.

## One-line Installation

Install without cloning the repository. The scripts check or install Node.js ≥22.13, install the npm CLI, then launch the console at `http://127.0.0.1:3210`.

```bash
# macOS (Terminal)
curl -fsSL https://deepaa.dev/install.sh | bash
```

```powershell
# Windows (PowerShell)
irm https://deepaa.dev/install.ps1 | iex
```

With Node.js already installed, run `npm install -g deepaa`. Installation starts the console automatically; run `deepaa` if it does not open. `DEEPAA_NO_LAUNCH=1` skips auto-start. The scripts also accept `DEEPAA_MIRROR=cn|global` to select the download channel.

## Your First Three Steps

1. Add a provider in **Provider management**, choose pay-as-you-go, plan, or subscription billing, and configure available models and credentials.
2. Connect an installed agent, choose its default provider and model, and enable CLI configuration sync if desired. Select a project and launch it from the dashboard.
3. Review balances, quotas, and multi-dimensional analytics on the dashboard. Open Session tracking, Interaction content, or Token pricing to inspect a specific request and its cost calculation.

## Understand the Cost of a Request

DeepAA connects what was consumed, which rules applied, and how the amount was calculated. Those records also feed task-level and global analytics.

| Billing channel | Reporting basis |
| --- | --- |
| **Pay-as-you-go** | Request usage, matched rates, credential multipliers, and settlement coefficients, with component charges and amounts before/after multipliers. Call-time billing snapshots preserve the calculation basis. |
| **Plans and subscriptions** | Quota consumption, windows, monthly fees, and allocation details, clearly labeled as **estimated cost**. Credit, monetary, and percentage quotas use their respective rules; missing evidence is marked pending or unavailable. |
| **Relay reconciliation** | Supported sub2api / new-api pay-as-you-go targets can reconcile site records and append adjustments when evidence and stability conditions are met. Original ledger entries and historical prices are preserved. |

Illustrative formulas for common token billing and credit-based plans:

```text
Usage charge (original currency) = Σ(billable units × applicable rate / 1,000,000) × credential multiplier
CNY display amount = original-currency amount × call-time settlement coefficient

Estimated credit-plan cost = monthly fee × (request credits / window quota) × (window days / 30)
```

Input, cache, and output use their respective rates without double counting. Long-context, time-based, service-tier, and promotion rules depend on the request's matched rules. The frozen billing record is the basis for each amount. Plan allocation is an estimate, not a per-request invoice from the provider. Percentage-based subscriptions may use quota-window deltas; the UI retains the estimation method and evidence.

The price center prioritizes manual overrides, official catalog prices, then LiteLLM fallback rates, and distinguishes same-named models from different providers. New rates apply to subsequent matches; historical requests keep their original rates, multipliers, and settlement coefficients. Catalog notifications describe published rule versions, with timing determined by catalog publication and sync.

## Supported Agents and Model Services

Five coding agents are integrated for access, managed configuration sync, and quick launch:

| Agent | Gateway protocols |
| --- | --- |
| **Codex** | OpenAI Responses |
| **Claude Code** | Anthropic Messages |
| **OpenCode** | OpenAI Responses / Chat Completions, Anthropic Messages |
| **DeepSeek Harness** | OpenAI Chat Completions / Responses, Anthropic Messages |
| **ZCode** | Anthropic Messages, OpenAI Chat Completions / Responses |

Reuse one provider across agents, or use models from multiple providers in the same agent. Available combinations depend on protocols, model capabilities, and explicit agent scopes. Balance sync, quota sync, and subscription passthrough depend on the provider and agent integration.

Observation uses gateway capture or supported local-log imports. Codex and ZCode support their corresponding official-direct logs. DeepSeek Harness logs enrich native session identities and are not enabled as a separate billing import source by default. Raw HTTP evidence comes only from gateway capture, and task relationships depend on the identities and evidence exposed by the client.

CLI sync backs up files before changing only DeepAA-managed fields and preserving unrelated configuration. Initial setup still requires selecting providers, models, and credentials. Failover retries only when conditions are met and no response content has been forwarded to the client; an already-started response is never transparently replayed.

## Tech Stack

- Framework: [Next.js 16](https://nextjs.org/) + [React 19](https://react.dev/)
- Language: TypeScript 5
- Package Manager: pnpm
- Runtime: Node.js 22.13+ or 23.4+ (Node built-in `node:sqlite` driver; the proxy is a standalone native Node HTTP process)
- Storage: one local v2 raw JSONL/blob archive + indexed SQLite projections

## Quick Start (Source Development)

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Build and start DeepAA

Build once after installation or source changes. `pnpm build` creates both the standalone proxy bundle and the Next.js production output:

```bash
pnpm build
```

Normal startup never builds implicitly (`pnpm start` = bare `deepaa` smart launch; use `pnpm open` for a foreground run):

```bash
node ./bin/deepaa.mjs
# or
pnpm start
```

The proxy and Web server are independent OS processes. Either can be started separately, and one exiting does not stop or restart the other:

```bash
node ./bin/deepaa.mjs proxy
node ./bin/deepaa.mjs web
# installed command equivalents
deepaa proxy
deepaa web
```

The proxy only needs `dist/proxy/proxy-server.mjs`; it does not need `.next`, Next.js, SQLite, or a running Web UI. The `web` command requires an existing `.next` production build and fails independently when it is missing.

For development, run the combined mode after building the proxy bundle, or start the proxy and Web server in separate terminals:

```bash
pnpm build:proxy
pnpm dev
# or, in separate terminals (script names mirror the deepaa commands)
pnpm dev:proxy
pnpm dev:web
```

The legacy `--prod` flag remains a production-mode alias, but it does not build:

```bash
node ./bin/deepaa.mjs --prod
```

Global installs (`npm install -g deepaa`) auto-launch DeepAA once the install finishes: a silent background smart-start brings up the services and opens the console in your browser. Set `DEEPAA_NO_LAUNCH=1` to opt out, or just run `deepaa` manually if the browser did not open. After installing the package command, both macOS and Windows can use:

```bash
deepaa
```

Bare `deepaa` is a short-lived smart launcher: it checks ports 3210/3211, starts whichever service is missing (as background daemons), waits for the Web UI to be ready, opens the browser, then exits. Closing the terminal or browser does not affect the running services. For a classic foreground run use `deepaa open` (Ctrl-C stops the Web and proxy processes with a bounded proxy drain).

Optional login auto-start with crash recovery (explicit user action only; config changes never restart the proxy):

```bash
deepaa service install    # register and start now (macOS LaunchAgent / Windows per-user scheduled tasks); opens the console once when ready
deepaa service start      # start the registered services (bootstraps missing ones, wakes idle ones) and open the console
deepaa service restart    # restart both services and open the console
deepaa service status     # per-service: running / installed
deepaa service uninstall  # unregister (disables login auto-start); running services are left untouched — stop them with deepaa stop
deepaa stop               # stop the Web and proxy services (registration is kept when installed; they auto-start at next login)
deepaa status             # read-only status of the Web and proxy services
```

On macOS the two services appear in System Settings → Login Items as a single grouped row (e.g. "Node.js Foundation — 2 items"): background items are grouped by the executable's code-signing team, and the agents run the locally installed official Node binary. Any other LaunchAgent on the machine that also points at a raw Node binary would join the same group (count grows accordingly) — a display-level trait of macOS, not something an npm-generated agent can change. Toggling that row off is macOS' "disallow" semantics: processes are stopped immediately and will not auto-start at next login (registration files are kept; the `deepaa status` copy for "registered but not running" covers this case). After toggling off, `deepaa` still brings the services up on demand; if the system refuses to launch the registered service, it automatically falls back to background daemons.

Browser behavior: a user-triggered start or restart opens `http://127.0.0.1:3210` once; login auto-start stays silent by default; crash recovery never opens a browser. Starting is verified — `service install` / `service start` wait for the ports to actually listen and report per-service status (with log paths) instead of firing-and-forgetting.

Desktop launcher icon is installed automatically with `npm install -g deepaa` (macOS `DeepAA.app` runs `deepaa` in Terminal and auto-closes the tab when done; Windows creates a Start Menu shortcut). If it is ever missing, simply running `deepaa` restores it automatically. Removal:

```bash
deepaa icon uninstall
```

Full command reference: `deepaa help`.

Default local endpoints:

- Web UI: `http://127.0.0.1:3210`
- Proxy: `http://127.0.0.1:3211`

By default, both servers bind to `127.0.0.1` only. This is intentional because captured traffic can contain API keys, cookies, system prompts, private user input, and model outputs.

### 3. Point Your Client at the Local Proxy

Open **Provider management** and create reusable provider targets. A target may define an OpenAI-compatible upstream URL, an Anthropic-compatible upstream URL, or both. These are request body formats, not provider categories. Models and OS credential references are shared by the target and can be scoped to the agents you connect.

New installations start with no Agent connection. Connect only the Agents you use, then explicitly choose each Agent's default provider target, model, credential, and whether DeepAA should manage its CLI configuration. The same provider target can be reused by multiple Agents.

Claude Code uses the Agent gateway path:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:3211/claude
```

Codex-compatible clients use:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:3211/codex/v1
```

Requests select the provider through a prefixed model ID such as `myrelay_gpt-5.6`. The route ID before the first underscore must contain only lowercase letters, numbers, dots, and hyphens. Historical unprefixed routes are rejected; there is no implicit default-target routing.

### Launch Codex or Claude Code from a proxy target

Connect the Agent, complete its default target/model/credential chain, then use the Agent block inside the target detail page:

- OpenAI targets show **Develop in Codex** and must support the Responses API.
- Anthropic targets show **Develop in Claude Code**.
- After selecting a project directory, the model follows the native project, explicit Codex profile, and user configuration precedence. A model must be entered manually if none is configured.
- New secrets are stored only in macOS Keychain or Windows Credential Manager. The browser subsequently holds only a redacted credential ID and a non-secret short fingerprint.
- CLI synchronization writes only DeepAA-managed sections to `~/.codex/config.toml`, the managed Codex catalog, and `~/.claude/settings.json`; it backs files up first and preserves unrelated user configuration. Disconnecting an Agent or disabling sync cleans the managed sections.
- The proxy URL and credential helper are injected without exposing real credentials. Codex and Claude Code always use the shared 3211 gateway and prefixed model IDs.
- Only when a Terminal.app launch command reaches 1024 UTF-8 bytes does DeepAA create a one-time private plan in the system temporary directory and invoke a fixed Node launcher. Short commands, iTerm2, and Windows keep the direct path. This fallback requests no additional macOS permission, contains no real secret, and deletes the plan as soon as the launcher claims it.
- DeepAA only opens the terminal; it does not wait for or monitor the Codex or Claude Code process. Claude Code uses one additional private temporary settings file that contains no secret.

Local development launch requires Codex CLI or Claude Code to already be available on PATH. macOS supports Terminal.app and iTerm2; Windows supports Windows Terminal and PowerShell. The Windows adapter is covered by unit tests but is not marked as verified until it passes validation on a real Windows host. The selected CLI still loads the project's AGENTS.md, CLAUDE.md, MCP servers, hooks, skills, plugins, and permission rules normally.

## Runtime Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3210` | Web UI and API server port |
| `PROXY_PORT` | `3211` | Local reverse proxy port |
| `HOST` | `127.0.0.1` | Default bind address for the Web UI and proxy |
| `PROXY_HOST` | `HOST` | Optional bind address for the proxy only |
| `DEEPAA_DATA_DIR` | User data directory (`~/.deepaa`); override is required to force `<project>/data` | Absolute shared raw, blob, SQLite, and local configuration directory |
| `DEEPAA_DERIVATION_DISK_RESERVE_BYTES` | `2147483648` | Free-space reserve below which the SQLite Worker enters `paused_disk` |

Example:

```bash
PORT=4000 PROXY_PORT=4001 node ./bin/deepaa.mjs
```

PowerShell equivalent:

```powershell
$env:PORT="4000"; $env:PROXY_PORT="4001"; node .\bin\deepaa.mjs
```

If you need LAN access, explicitly set `HOST=0.0.0.0` and add your own access control first.

### Maintainer-only: local catalog override

`DEEPAA_CATALOG_PATH` is an internal-only switch used by the official catalog
maintainers to load a local draft catalog instead of the online one. It is not a
user-facing setting and must never be exposed in the UI or persisted in config files.

- When set to an **absolute** path, the provider catalog is read **only** from that
  file: no network access, and **no cache file is written**.
- If the file is missing or unparsable the load **fails loudly** (it never silently
  falls back to the normal path, so a maintainer can never mistake an untested catalog
  for a tested one).
- While active, the Web UI shows a persistent "maintenance test mode" banner and tags
  notification revisions as test data.
- Unset (the default), behavior is exactly as before: remote URL → local cache →
  bundled catalog.

```bash
DEEPAA_CATALOG_PATH=/abs/path/to/pending.jsonl \
DEEPAA_DATA_DIR=/tmp/deepaa-catalog-test \
PORT=3310 PROXY_PORT=3311 \
node ./bin/deepaa.mjs
```

The official website repository drives this via `pnpm catalog:test`; see
`deepaa.dev` → 「目录「先测后发」工作流」.

### Catalog cache monotonicity guard

A successful remote fetch will **not** overwrite a newer local cache with older
content (e.g. a stale CDN copy or an accidentally republished lower revision). The
comparison uses `publishedAt` first and `catalogRevision` as the tie-breaker, matching
`catalogVersionNotNewer` in the pricing-sync gate.

## How It Works

```text
Agent / SDK / CLI
        |
        v
Standalone Node proxy -> configured upstream API or gateway
        |
        +-> data/captures/v2/*.jsonl + data/blobs/
                    |
                    v
          asynchronous SQLite Worker
                    |
                    v
          data/deepaa.sqlite -> Next.js UI/API
```

The proxy resolves the Agent from the local path and the provider from the prefixed model ID, forwards the request, streams the upstream response to the client, and appends exactly one v2 raw exchange after completion. It does not import SQLite or business-derivation code. The Next.js Node process starts an independent single-writer Worker that tails complete JSONL lines and updates SQLite one exchange per transaction. A stopped, locked, or failed Worker cannot alter proxy responses.

## Web UI

The Next.js web interface has five top-level views — Dashboard, Session tracking, Interaction content, Token pricing, and Provider management. The three data views preserve the same six-part URL context (`target`, `agent`, `session`, `thread`, `turn`, `step`):

- Dashboard (default landing): one-click Agent launcher row (Codex / Claude Code / OpenCode / DeepSeek Harness / ZCode) plus a provider status bar (plan quota windows, pay-as-you-go balances, instant sync), followed by reorderable modules — scope overview KPIs (requests / tokens / spend with total·payg·plan dimensions), token cost leaderboard, model/provider/agent analysis, consumption trends, plan consumption, and an hourly intensity heatmap.
- Session tracking: `target + Agent -> Session -> recursive Thread -> Turn -> Step`, with independently collapsible nodes and materialized scope summaries.
- Interaction content: bounded, cursor-paged prompt/model-output reconstruction for the current Session, Thread, Turn, or Step, with one-click full Markdown / JSONL export.
- Token pricing: the same hierarchy plus request, token, vendor cost, actual cost, and duration details, including an hourly relay reconciliation panel.
- Provider management: target sidebar plus detail tabs (Basics / Keys & Models / Agent access); new providers default to the official-preset wizard with plan quota sync, balance sync, price multipliers, and agent CLI config propagation.

Metadata requests such as `/models` without an explicit Session identity are recorded as target-level auxiliary ledger entries. They do not create placeholder Sessions or Threads and cannot take over the latest workbench selection; target-level and time-range token summaries still include them.

The raw request view includes the full request body, selected proxy target, upstream path, and a copyable `curl` command. The raw response view includes the proxy route, parsed JSON where possible, raw text fallback, and stream completeness diagnostics for supported SSE protocols.

## Session Attribution and Scoped Inspection

Requests are attributed to Sessions, recursive Threads, Turns, and Steps using native agent identities and verifiable call relationships. Switching models or providers should not split one task into a new daily model-based session. Where native identities are unavailable, the UI retains the relationships it can establish.

The dashboard aggregates by time range; Session tracking follows the task hierarchy. Interaction content and Token pricing share the same business context. Select a Session, Thread, Turn, or Step before inspecting or exporting. Default previews are paginated and byte-bounded, with limits explicitly shown.

## HTTP API

The Web UI backend exposes local endpoints for proxy configuration, capture sessions, agent turns, and exchange details:

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/proxy-config` | Read V3 proxy targets, Agent connections, the local gateway URL, and revision |
| `PUT` | `/api/proxy-config` | Atomically patch/delete targets or connect/disconnect an Agent with `expectedRevision` |
| `GET` | `/api/development-launch/capabilities` | Detect local CLIs, terminals, and credential-store support |
| `POST` | `/api/development-launch/select-directory` | Open the native project directory picker |
| `POST` | `/api/development-launch/preflight` | Resolve bounded project and user launch configuration |
| `GET/POST/DELETE` | `/api/development-launch/credentials` | Manage development credential references in the OS store |
| `POST` | `/api/development-launch/start` | Build a secret-free direct command and launch the CLI in a local terminal |
| `GET` | `/api/agent-sessions` | List agent sessions derived from captured exchanges |
| `GET` | `/api/agent-sessions/:sessionId/threads` | Page root or direct child Threads |
| `GET` | `/api/agent-threads/:threadId/turns` | Page Turns for one Thread |
| `GET` | `/api/agent-turns` | List agent turns with step summaries |
| `GET` | `/api/agent-turns/:turnId/steps` | Page Steps with tool-action summaries |
| `GET` | `/api/exchanges/:exchangeId` | Read one captured exchange in full detail |

These endpoints are intended for local use.

## Data Storage and Security

New data is written to:

```text
data/captures/v2/capture-*.jsonl
data/blobs/<sha256-prefix>/<sha256>.body.gz
data/deepaa.sqlite
data/deepaa.sqlite-wal
data/deepaa.sqlite-shm
data/config/development-credentials.json
```

The JSONL/blob files are the only raw evidence copy. SQLite stores indexed projections and byte references, not duplicate full prompts or responses. Lists, scope aggregates, interaction candidates, and token pricing are filtered and paged in SQL first; the application reads a raw JSONL range or blob only after a bounded query selects it.

`deepaa.sqlite-wal` and `deepaa.sqlite-shm` are normal SQLite WAL runtime files. Do not delete or copy them independently while the UI/Worker is running. Stop the service before backing up the database and keep the database and WAL state consistent.

This release does not import legacy captures. Existing `data/derived/` and `data/indexes/` directories are ignored by the application and are not deleted automatically. Raw capture retention is also manual: cleanup requires a separate review and explicit confirmation because it is destructive.

The local proxy settings file is written to:

```text
data/proxy-config.json
```

The `data/` directory is ignored by git. Do not publish or share it unless you have reviewed and redacted it.

`data/config/development-credentials.json` contains only credential IDs, labels, target associations, and short SHA-256 fingerprints. Real secrets remain in the OS credential store. Codex or Claude Code uses a one-time private launch plan without real secrets only when a Terminal.app command reaches 1024 UTF-8 bytes; the fixed launcher deletes that plan before starting the CLI. Claude Code's private temporary settings also contain no secrets. Failed launches remove their artifacts immediately, while crash leftovers are removed by a bounded 24-hour cleanup on a later capability check or launch.

Captured data may include:

- Authorization headers, API keys, cookies, and custom credentials.
- System prompts, user prompts, tool inputs, and tool results.
- Full model responses, SSE chunks, token usage, and provider metadata.

Security guidance:

- Keep the default loopback-only bind address unless you have a specific reason to expose it.
- Do not expose `PORT` or `PROXY_PORT` to untrusted networks.
- Add authentication and network access control before any remote access.
- Redact headers and payloads before sharing logs or screenshots.

Known security boundary: raw-capture authentication-header redaction is not implemented in this release. `Authorization`, `X-Api-Key`, and similar headers sent by Codex or Claude Code through the local proxy may still be stored verbatim in raw captures. Treat `data/captures` as sensitive before use, backup, or sharing.

## Project Structure

```text
.
├── bin/
│   ├── deepaa.mjs
│   ├── credential-helper.mjs
│   └── windows-credential.ps1
├── src/
│   ├── app/                 # Next.js pages and bounded API routes
│   ├── components/          # Session/Thread workbench and viewers
│   ├── lib/db/              # SQLite schema, cursors, and indexed queries
│   ├── lib/ingestion/       # bounded source reader and single-writer Worker
│   ├── lib/harness/         # protocol normalization and raw evidence types
│   ├── reverse-proxy.ts
│   ├── proxy-config.ts
│   ├── store.ts
│   └── instrumentation.ts
├── tests/
├── package.json
└── tsconfig.json
```

## Development

```bash
pnpm build        # explicitly build the proxy bundle and Next.js output
pnpm build:proxy  # build only dist/proxy/proxy-server.mjs
pnpm proxy        # start only the built standalone Node proxy (= deepaa proxy)
pnpm dev:proxy    # run the proxy TypeScript entry in watch mode (= deepaa dev proxy)
pnpm web          # start only the existing Next.js production build (= deepaa web)
pnpm dev:web      # start only the Next.js development server (= deepaa dev web)
pnpm start        # smart launch (= deepaa; starts services in the background and opens the console)
pnpm open         # foreground run of the proxy and Web production servers (= deepaa open)
pnpm dev          # foreground run of the built proxy + Next.js development server (= deepaa dev)
pnpm test
pnpm typecheck
pnpm verify:node-only
```

## Troubleshooting

### The Web UI Shows No Live Data

Confirm that your client uses an Agent gateway path and a prefixed model ID:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:3211/claude
# or
export OPENAI_BASE_URL=http://127.0.0.1:3211/codex/v1
```

Also confirm that the Agent is explicitly connected, its default target/model/credential chain is complete, the target has the required upstream URL, and the requested model is formatted as `<targetId>_<modelId>`. Unprefixed `http://127.0.0.1:3211/v1/...` routes are intentionally rejected.

If raw capture files are growing but the UI remains stale, inspect the derivation status endpoint and SQLite metadata:

```bash
curl -s http://127.0.0.1:3210/api/derivation-status
sqlite3 "${DEEPAA_DATA_DIR:-data}/deepaa.sqlite" \
  'select worker_status, worker_error, data_version from schema_meta where id=1;'
```

- `running`: the Worker is processing or polling for v2 raw lines.
- `idle`: there is currently no pending work.
- `paused_disk`: free space is below `DEEPAA_DERIVATION_DISK_RESERVE_BYTES`; free disk space or deliberately lower the reserve, then restart.
- `failed`: inspect `worker_error`, file permissions, database integrity, and available disk space. The proxy remains independent and should continue forwarding/writing v2 raw.

After a database error, stop the UI before manipulating SQLite files. Keep the raw archive intact; rebuilding a projection must never require replaying requests to a real model.

### Upstream Requests Fail

Check that the upstream URL is correct and that your original client still sends the required API key or authorization headers.

### Responses API Streaming Stops Early

Some compatible services expose `/v1/responses` while clients may call `/responses`. If needed, configure the upstream URL with the `/v1` base path:

```text
https://api.example.com/v1
```

DeepAA avoids duplicating the base path, so `/responses` becomes `/v1/responses` instead of `/v1/v1/responses`.

### Raw Request or Raw Response Is Empty

Only requests sent through the local proxy have full raw HTTP exchange data. Make sure the client uses an Agent gateway base URL, such as `http://127.0.0.1:3211/codex/v1` for Codex or `http://127.0.0.1:3211/claude` for Claude Code, and a provider-prefixed model ID.

### Port Conflict

Set custom ports:

```bash
PORT=4000 PROXY_PORT=4001 pnpm start
```

## Current Limitations

- Captures are intentionally complete and may contain sensitive data.
- There is no built-in authentication yet.
- Streaming events are persisted after the stream finishes, so a live stream may not appear in detail until completion.
- The launcher does not supervise children by itself; crash recovery requires the opt-in user services (`deepaa service install`, restart-on-crash only).
- Real Windows process-tree and rename behavior remains a release-gate item until it is validated on Windows hardware.

## Author

Created and maintained by AIAgentAndy.

Contact: AIAgentAndy001@gmail.com

## License

MIT
