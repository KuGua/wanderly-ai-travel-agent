# Wanderly — AI Travel Agent

> **A privacy-first, agentic workspace for planning international trips—individually and together.**

<p>
  <img alt="Project status: Hackathon MVP" src="https://img.shields.io/badge/status-Hackathon%20MVP-7c3aed?style=flat-square" />
  <img alt="Node.js 20 or later" src="https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white" />
  <img alt="Next.js" src="https://img.shields.io/badge/Next.js-16-000000?style=flat-square&logo=nextdotjs&logoColor=white" />
  <img alt="Fastify" src="https://img.shields.io/badge/Fastify-5-000000?style=flat-square&logo=fastify&logoColor=white" />
  <img alt="Deployment target: AWS" src="https://img.shields.io/badge/deployment-AWS-232F3E?style=flat-square&logo=amazonwebservices&logoColor=white" />
</p>

<p>
  <a href="docs/PRD.md">Product requirements</a> ·
  <a href="docs/technical-architecture-overview.md">Architecture</a> ·
  <a href="apps/api/API.md">API reference</a> ·
  <a href="#chinese">中文说明</a>
</p>

Wanderly turns international-trip planning from disconnected conversations and
search tabs into a coordinated, evidence-backed workflow. Every traveller has a
private profile and Personal Agent. For a shared trip, members explicitly
authorize the minimum trip-specific information needed for planning; the Shared
Agent then assembles a source-backed plan across flights, stays, ground
mobility, activities, and visa/entry-readiness tasks.

The model, browser, and provider response are never business truth by
themselves. Consent, immutable constraint snapshots, plan versions, stale
state, confirmations, and booking idempotency are enforced by the server and
database.

## Highlights

| Capability | What it provides |
| --- | --- |
| Personal workspace | Owner-only profiles, durable private agent threads, and personal research. |
| Shared planning | Field-level consent, multi-origin travel comparison, and coordinated destination candidates. |
| Evidence integrity | Source and capture time for travel facts; unavailable data is never fabricated. |
| Durable execution | Recoverable server-side tasks, safe progress streaming, and final-state recovery. |
| Change awareness | Relevant changes make an affected plan `STALE` and initiate a replan. |
| Controlled action | Every required member confirms the same current plan before booking sandbox orchestration. |

## Planning lifecycle

```mermaid
flowchart LR
  A[Private preferences] --> B[Explicit trip consent]
  B --> C[Immutable constraint snapshot]
  C --> D[Shared planning task]
  D --> E[Evidence-backed plan]
  E --> F{Constraint or evidence changed?}
  F -->|Yes| G[Mark plan STALE and replan]
  G --> D
  F -->|No| H[Required-member confirmation]
  H --> I[Idempotent booking sandbox]
```

## Safety and product boundaries

Wanderly is a planning MVP, not an online travel agency or legal service.

- **Private by default.** Profiles, passports/nationality, and private chats
  are not shared automatically and must not enter logs, metrics, traces,
  browser persistence, or fixtures.
- **Evidence over simulation.** A missing, failed, stale, or untrusted live
  result is `UNAVAILABLE`—never a substitute price, inventory claim, exchange
  rate, or visa conclusion.
- **Server-enforced authority.** Only the server creates snapshots, activates
  plans, changes stale state, accepts confirmations, and invokes booking.
- **No irreversible consumer action.** Visa and entry output is a personal
  readiness checklist with official-verification next steps, not legal advice
  or an application service. There are no real payments, automatic charges,
  reservations, or visa applications.
- **Credentials stay server-side.** Fixtures are for tests and adapter-contract
  validation only; they never supply the user-facing product path.

Read the full MVP constraints in [TECH_STACK.md](TECH_STACK.md) and
[docs/PRD.md](docs/PRD.md).

## Architecture

```mermaid
flowchart LR
  W[Next.js web app] -->|REST + authenticated SSE| A[Fastify API]
  A --> D[(PostgreSQL)]
  A --> Q[Durable agent tasks]
  Q --> R[Worker]
  R --> M[Model gateway]
  R --> P[Typed travel-provider adapters]
  P --> F[Flights · Stays · Ground · Activities · Visa]
  D --> R
```

The Hackathon deployment target is Next.js on AWS Amplify Hosting, Fastify on
AWS App Runner, a durable Worker on ECS Fargate, PostgreSQL on Amazon RDS,
Cognito for production identity, and AWS Secrets Manager/KMS for secrets.
Infrastructure is defined with AWS CDK v2 in [`infra/`](infra/). See the
[deployment guide](docs/aws-hackathon-deployment.md).

## Repository layout

```text
apps/
  api/       Fastify API, Worker, Drizzle schema, migrations, and tests
  web/       Next.js 16 frontend (App Router, next-intl, MapLibre)
infra/       AWS CDK v2 stacks and infrastructure tests
docs/        PRD, architecture, operations, implementation contracts, test scenarios
assets/      UI prototypes and design assets
TECH_STACK.md  Architecture decisions and non-goals
```

## Run locally

### Prerequisites

- Node.js 20 or later
- npm
- Docker Desktop / Docker Compose for PostgreSQL
- A model-provider API key for conversations and model-backed planning

### 1. Install and configure

Run from the repository root:

```bash
npm --prefix apps/api install
npm --prefix apps/web install
```

Create local configuration without overwriting an existing file:

```powershell
if (!(Test-Path apps/api/.env)) { Copy-Item apps/api/.env.example apps/api/.env }
if (!(Test-Path apps/web/.env.local)) { Copy-Item apps/web/.env.example apps/web/.env.local }
```

Set `MODEL_GATEWAY_API_KEY` and `MODEL_GATEWAY_MODEL` only in
`apps/api/.env`. Never put model, provider, database, JWT, or callback secrets
in `apps/web/.env.local` or a `NEXT_PUBLIC_*` variable.

[Local Development Authentication](docs/local-development-auth.md) explains the
recommended local authentication and provider setup. `custom-local` is the
database-backed multi-user mode; `local-dev` is loopback-only and intended for
a single-user smoke test. Production uses Cognito.

### 2. Start the stack

Use three terminals:

```bash
# Terminal 1 — PostgreSQL, migrations, and API (port 3000)
cd apps/api
docker compose up -d postgres
npm run db:migrate
npm run dev
```

```bash
# Terminal 2 — Durable Agent Worker
cd apps/api
npm run worker:dev
```

```bash
# Terminal 3 — Web app (port 3001), from the repository root
npm --prefix apps/web run dev -- --port 3001
```

Open [http://localhost:3001](http://localhost:3001); the application redirects
to the locale-aware Explore experience. Fastify OpenAPI documentation is at
[http://localhost:3000/docs](http://localhost:3000/docs).

`docker compose up -d` starts PostgreSQL only. Use
`docker compose --profile full up -d --build` from `apps/api/` only when you
specifically want API and Worker containers as well.

### Provider credentials

Selecting a provider does not make it usable until its required server-side
credential is configured. The affected capability returns `UNAVAILABLE` rather
than substituted data. See the [live-tool credential matrix](docs/local-development-auth.md#live-tool-credentials)
and [runtime data policy](docs/runtime-data-policy.md).

## Validate

```bash
npm --prefix apps/api run lint
npm --prefix apps/api run typecheck
npm --prefix apps/api test
npm --prefix apps/api run docs:verify

npm --prefix apps/web run lint
npm --prefix apps/web run typecheck
npm --prefix apps/web test
npm --prefix apps/web run build

npm --prefix infra run build
npm --prefix infra test
```

The API test command prepares an isolated test database before Vitest runs. Do
not use production provider credentials in tests.

## Documentation

- [Product requirements and acceptance criteria](docs/PRD.md)
- [Technical architecture overview](docs/technical-architecture-overview.md)
- [API contract](apps/api/API.md)
- [Runtime data and evidence policy](docs/runtime-data-policy.md)
- [Observability SLOs](docs/observability-slo.md)
- [Test scenarios](docs/test-scenarios.md)
- [AWS deployment guide](docs/aws-hackathon-deployment.md)

---

<details id="chinese">
<summary><strong>中文说明</strong></summary>

<br />

> 面向国际旅行协作规划的、隐私优先的 Agentic 工作空间。

Wanderly 是 AWS Hackathon 的 MVP。每位旅行者拥有私有 Profile 和私有
Personal Agent 对话；在共享行程中，成员仅授权本次规划所需的最少信息。
Shared Agent 基于来源与检查时间，对航班、住宿、地面交通、活动以及签证/入境
准备事项进行协同规划。

### 核心能力

- 中英文 globe-first 探索体验；
- 私有 Profile、持久对话与个人旅行研究；
- 单人或多人共享行程、字段级授权、不可变约束快照与方案版本；
- 可恢复的服务端任务，协调航班、住宿、交通、活动与 visa/entry readiness；
- 约束、价格或库存变化时使方案进入 `STALE` 并重新规划；
- 所有 required members 确认同一最新方案后，才调用幂等的 booking sandbox。

### 重要边界

- Profile、国籍/证件资料和私有对话默认不共享；不会写入日志、指标、trace、
  浏览器持久化或 fixture。
- 所有实时事实均附带来源与检查时间；无数据、不可信或 provider 失败时返回
  `UNAVAILABLE`，不会伪造报价、库存或签证结论。
- 签证/入境能力仅提供个人准备清单和官方核验下一步，不提供法律意见、获批承诺
  或代办申请。
- 不包含真实支付、自动扣款、真实预订或签证申请；预订只是显式确认后的 sandbox
  编排。

### 本地运行

需要 Node.js 20+、npm、Docker Desktop，以及用于模型对话/规划的 API key。
复制 `apps/api/.env.example` 到本地的 `apps/api/.env`，复制
`apps/web/.env.example` 到 `apps/web/.env.local`，并只在 API 的 `.env` 中
填入模型密钥与模型名称。

启动 PostgreSQL、迁移、API、Worker 和 Web 的完整步骤见英文版
[Run locally](#run-locally)；本地认证、配置与供应商凭据请阅读
[本地开发认证指南](docs/local-development-auth.md)。

完整产品边界、架构、验收和部署说明见 [PRD](docs/PRD.md)、
[TECH_STACK.md](TECH_STACK.md)、[测试场景](docs/test-scenarios.md) 与
[AWS 部署手册](docs/aws-hackathon-deployment.md)。

</details>
