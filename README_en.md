# DeepAA

**Unify access to model providers. Trace agent calls. Understand usage and costs.**

DeepAA (Deep Agent Analytics) is a free, open source **AI agent gateway and observability tool** that runs locally. It brings model providers, models, API keys, and agent configuration into one place, traces calls between agents and models, and connects usage, costs, and calculation details to individual requests. Configurable model failover helps reduce disruptions caused by model or service failures.

[Website & product preview](https://deepaa.dev/en-US) · [Installation & setup](https://deepaa.dev/en-US/docs) · [中文文档](./README.md) · [MIT license](./LICENSE)

## Core Value

When you use multiple agents, models, and providers, you need to know how to manage access, what each task called, how much it consumed, and how its cost was calculated. DeepAA brings access configuration, call records, and cost analysis into one local workspace.

| Capability | What you get |
| --- | --- |
| **Unified provider and agent access** | Manage official and relay model services, models, and API keys centrally. Enable configuration sync to use compatible models from multiple providers in the same agent with less manual setup. |
| **Agent call tracing** | Follow call relationships across tasks, child threads, turns, and steps, with prompts, model outputs, tool interactions, token usage, and latency shown together. |
| **Context and capability evidence** | Inspect the tools, MCP tools, skills, and injected rules carried in a request, along with estimated context composition, changes between steps, and compaction evidence. |
| **Cost transparency for each request** | Break down input, cache read/write, and output charges. Inspect rates, multipliers, promotions, and calculation details; compare usage and costs by model, provider, agent, and time. |
| **Provider status and rule updates** | View balances and remaining plan quotas for supported providers, and learn about new models and changes to prices, plans, promotions, and capabilities in the published catalog. |
| **Model failover** | Configure an ordered chain of backup models. When the required conditions are met and no response content has been returned yet, switch to an available model to reduce coding disruptions from model or service failures. |

Five coding agents are currently integrated: **Codex, Claude Code, OpenCode, DeepSeek Harness, and ZCode**. Connect official model services, plans, subscriptions, aggregators, and custom relay providers. Available combinations depend on protocols, model capabilities, and agent support.

For plans and subscriptions, the estimated cost of each request strictly follows the provider's credit conversion formula. If no explicit credit conversion formula is available, costs are estimated proportionally using usage over the plan's quota window. Supported relays can reconcile bills and apply adjustments. DeepAA itself is free; model services charge according to their providers' billing rules.

Observability and analytics data is kept strictly on your machine and never uploaded to any DeepAA cloud service.

## Screenshots

**Dashboard** — one-click agent launch, a unified view of provider balances and remaining plan quotas, and timely, accurate usage and cost analytics across multiple dimensions.

<p align="center">
  <img src="docs/screenshots/dashboard.png" alt="DeepAA dashboard" width="960">
</p>

<table align="center">
  <tr>
    <td align="center" valign="top">
      <a href="docs/screenshots/sessions.png"><img src="docs/screenshots/sessions.png" width="340" alt="Session tracking"></a>
      <br><br><sub><b>Session tracking</b> · Session → Thread → Turn → Step</sub>
    </td>
    <td align="center" valign="top">
      <a href="docs/screenshots/token-pricing.png"><img src="docs/screenshots/token-pricing.png" width="340" alt="Token pricing"></a>
      <br><br><sub><b>Token pricing</b> · Costs for each request with step-by-step formulas</sub>
    </td>
    <td align="center" valign="top">
      <a href="docs/screenshots/proxy-management.png"><img src="docs/screenshots/proxy-management.png" width="340" alt="Provider management"></a>
      <br><br><sub><b>Provider management</b> · Targets, keys & models, agent access</sub>
    </td>
  </tr>
</table>

<p align="center"><sub>Click a thumbnail to view it full size</sub></p>

## Installation and Startup

Currently supported on **macOS and Windows**.

### One-line Installation (Recommended, No Repository Clone Required)

```bash
# macOS (Terminal)
curl -fsSL https://deepaa.dev/install.sh | bash
```

```powershell
# Windows (PowerShell)
irm https://deepaa.dev/install.ps1 | iex
```

The install scripts prepare Node.js as needed, automatically select the faster download channel between China's npmmirror and the official source, install DeepAA through npm, then start the services and open the console at `http://127.0.0.1:3210`.

### Install with npm

With Node.js 22.13+ already installed (23.x requires 23.4+), you can install directly; whether npm uses a China mirror or the official registry depends on your environment configuration:

```bash
npm install -g deepaa
```

Installation automatically starts DeepAA and opens the console (if it does not open, run `deepaa`).

### Install from Source

To run from source or contribute to development, you need Node.js 22.13+ (23.x requires 23.4+) and pnpm:

```bash
# 1. Clone the GitHub repository
git clone https://github.com/AIAgentAndy/DeepAA.git
cd DeepAA

# 2. Install dependencies
pnpm install

# 3. Build the production version
pnpm build

# 4. Start DeepAA and open the console
pnpm start
```

### Everyday Startup

If you installed with the one-line script or npm, search your computer for DeepAA to open the console (shortcut location: **Applications** on macOS or the **Start menu** on Windows). You can also use these commands:

```bash
deepaa          # Start services and open the console
deepaa status   # Check service status
deepaa stop     # Stop services

deepaa service install # Register system services: auto-start at login + crash recovery
```

For source installations, start with `pnpm start`. For auto-start at login and other startup options, see the [official documentation](https://deepaa.dev/en-US/docs).

## Two Steps to Set Up and Start Observing

Have your agent client ready, along with a provider API key or the corresponding subscription login.

### Step 1: Add a Provider and Connect Your Agent

Open **Provider management** in the console and follow the setup prompts:

- **Add a provider**: choose an official preset for model providers such as DeepSeek or OpenAI. For relays and other services, choose a non-official preset and enter the upstream URL.
- **Configure models and credentials**: select models and enter an API key. For subscriptions, simply use the official login as prompted.
- **Connect your agent**: select the agent you want to use and confirm the connection.

### Step 2: Launch Your Agent and Start Working

Click the agent you want to use on the dashboard. In the quick launch dialog, select a project directory and the required provider, model, or launch method. You can also manually launch an agent that is already configured. For subscriptions, follow the interface prompts to use the corresponding official login or official mode.

Then start a normal conversation in your agent (select a DeepAA gateway model). DeepAA automatically records and analyzes calls within the connected scope. Open `http://127.0.0.1:3210` whenever you want to inspect them:

- **Dashboard**: view provider balances, remaining plan quotas, and usage and cost summaries.
- **Session tracking**: follow tasks and steps to inspect calls, context, and tool interactions.
- **Interaction content**: inspect prompts, model outputs, and tool results.
- **Token pricing**: inspect token usage, costs, and calculation details for each request.

## More Documentation

For detailed agent setup, billing rules, failover, data management, runtime configuration, and troubleshooting, see the [official documentation](https://deepaa.dev/en-US/docs).

## Community and Feedback

[Report issues or share suggestions](https://github.com/AIAgentAndy/DeepAA/issues), or scan the QR code to join the QQ group:

<p align="center">
  <img src="docs/screenshots/qrcode-qq.png" width="200" alt="DeepAA QQ group QR code">
</p>
<p align="center"><sub>Scan to join the DeepAA QQ group</sub></p>

## Author

Created and maintained by AIAgentAndy.

Contact: AIAgentAndy001@gmail.com

## License

[MIT](./LICENSE)
