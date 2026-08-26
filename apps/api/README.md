# AI Travel Agent — 后端 MVP

> Hackathon 项目：基于授权数据共享、可验证旅行数据和预订沙箱的国际旅行协同规划。

## 快速开始

完整的本地 browser-to-Agent 双服务配置与 smoke test 请参见
[`docs/local-development-auth.md`](../../docs/local-development-auth.md)。

```bash
# 1. 安装依赖
npm install

# 2. 复制环境配置
cp .env.example .env

# 3. 启动 PostgreSQL（本地或 Docker）
# 方案 A：Docker
docker compose up -d postgres

# 方案 B：本地 PostgreSQL（确保 DB_HOST、DB_PORT 等与 .env 一致）

# 4. 执行数据库迁移
npm run db:migrate

# 5. 分别启动 API 与持久 Agent Worker
npm run dev
npm run worker:dev
```

服务器运行于 `http://localhost:3000`；OpenAPI 文档位于 `http://localhost:3000/docs`。

## LLM 配置

模型调用只在 API 服务端进行，并且必须配置真实模型 provider。要启用 Gemini，
请在 `.env` 中设置：

```dotenv
MODEL_GATEWAY_PROVIDER=gemini
MODEL_GATEWAY_API_KEY=your_gemini_key
MODEL_GATEWAY_MODEL=gemini-3.1-flash-lite
```

本地 `.env.example` 明确设置 `MODEL_GATEWAY_MODEL=gemini-3.1-flash-lite`，并使用
内置 OpenAI-compatible endpoint；运行时不会默认选择任何 provider 或模型，缺少任一
必填配置即 fail closed。也可选择 `MODEL_GATEWAY_PROVIDER=openai`，仍使用
同一个 `MODEL_GATEWAY_API_KEY`；或选择 `openai-compatible` 并额外设置
`MODEL_GATEWAY_BASE_URL` 和 `MODEL_GATEWAY_MODEL`。后者适用于提供 OpenAI Chat
Completions 兼容接口的服务。
原生 API 不兼容该接口的供应商需要单独 provider adapter，不能仅靠更换 key 启用。
不要将密钥提交到仓库或暴露给浏览器。

## Cognito 登录与 API 认证

除地图位置参考外，受保护 API 只接受 Cognito access token，不接受用户 ID、邮箱或
手机号作为身份 header。用户可在 Cognito User Pool 中通过邮箱或手机号登录，客户端随后发送：

```http
Authorization: Bearer <cognito-access-token>
```

需要调用 Profile、行程、对话、授权、规划、确认或预订接口的本地和部署环境必须配置
`COGNITO_USER_POOL_ID` 与 `COGNITO_CLIENT_ID`。API
验证签名、issuer、client ID、token use 与过期时间，并使用已验证 token 的
`sub` 关联数据库用户。缺少或无效 token 返回统一 `401`，不会回显 token 或
账号信息。

`POST /api/v1/explore/location-reference` 是唯一的匿名只读例外：它只使用本次请求的
明确点击坐标匹配仓库内离线数据，不写数据库、audit 或日志，也不创建身份、灵感、候选或旅行事实。
每个 API 进程以短暂、加盐哈希的客户端地址状态限流为每分钟 30 次；此限制不跨实例共享，生产多实例
部署必须在网关或 CDN 追加共享限流。

在 Cognito 尚未配置前，本地 browser-to-Agent 验证可显式设置
`AUTH_MODE=local-dev`、`NODE_ENV=development`、`HOST=127.0.0.1`。该模式只接受
loopback socket 请求并由服务端固定映射一个本地身份；production、非 loopback 绑定和
非 loopback 客户端均 fail closed。浏览器不发送 token 或 user ID。详见
[`docs/local-development-auth.md`](../../docs/local-development-auth.md)。

## Sandbox callback 配置

`POST /api/v1/bookings/callback` 不使用 Cognito bearer token，而是要求
`X-Sandbox-Timestamp` 与 `X-Sandbox-Signature`。本地 `.env` 中必须设置仅限
本地使用的随机 `SANDBOX_HMAC_SECRET`；服务端按
`${timestamp}.${rawRequestBody}` 计算 HMAC-SHA256，并只接受五分钟窗口内的
请求。缺少配置或认证失败都会 fail closed，且不会回显具体失败原因。

## 核心能力

- **Profile CRUD** — 默认私密；未经明确授权绝不共享。
- **共享行程管理** — 创建行程、邀请成员、管理目的地。
- **基于授权的数据共享** — 按字段、范围和行程授予/撤回授权。
- **约束快照** — 每轮规划使用不可变的已授权数据快照。
- **Live provider 边界** — 未配置或不可用的航班/住宿/地面交通能力显式返回 unavailable；生产路径不生成静态报价或证据。
- **离线地图位置参考** — `POST /api/v1/explore/location-reference` 仅处理用户显式点击的坐标，返回来源化国家、可选省/州和最近主要城市。它不是地址、旅行候选或 provider 事实，且坐标不进入日志、指标、trace、审计或数据库；参见 [位置参考数据](../../docs/location-reference-data.md)。
- **规划控制平面** — `ModelGateway` 输出在写入前必须通过严格结构、snapshot 字段授权、路线边界、来源完整性与 provider evidence 精确匹配校验；失败返回 correlation-aware `422`，且不创建 plan。
- **Model/Skill integration** — `gateway-factory.ts` 只配置 Gemini、OpenAI 或 OpenAI-compatible `LLMGateway`；LLM 路径记录安全的 model/prompt version 与 Agent run，provider、timeout 或 schema 失败时 fail closed。结构化模型输出仍须通过最终控制平面校验。
- **Owner-only Personal Agent 对话** — `/threads/:threadId/turns` 原子持久化 USER 与 durable task 并返回 `202`；独立 Worker 通过 `thread.recall → travel.conversation → ModelGateway` 运行 Gemini/OpenAI-compatible stream。只有通过增量安全门的片段可进入鉴权 SSE，最终完整校验通过后才原子写入 ASSISTANT。相同 request ID 幂等，断开浏览器不取消任务，显式 cancel 是唯一取消入口。owner UI 可读取原始会话，但 task、SSE、safe recall、audit、metrics 与日志不持久化正文或 partial output。
- **入境准备** — 每位成员各有清单；国籍未共享时显示“请向官方来源核验”。
- **方案版本管理** — 生成、过期、带差异的重规划。
- **三人确认** — 三位必需成员全部确认后，才可进行预订沙箱。
- **预订沙箱** — 不发生真实付款；返回演示参考号。
- **幂等性** — 规划、变化事件和预订操作均为幂等。
- **审计轨迹** — 所有敏感操作均以关联 ID 记录。
- **安全可观测性** — Pino 统一脱敏日志；`/metrics` 仅提供进程内 MVP
  Prometheus text，标签使用固定低基数 allow-list。仓库当前不包含生产
  metrics/trace exporter 或持久化遥测后端。

## 测试

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

如只需验证 lockfile 与依赖解析、且不希望执行 `postinstall` 或访问数据库，可运行：

```bash
npm ci --dry-run --ignore-scripts
```

安装脚本许可由 `package.json` 的 `allowScripts` 按确切版本维护。更新带安装脚本的依赖后，先运行 `npm approve-scripts --allow-scripts-pending` 审核新增项；不要使用不经审核的 `--all`。生产依赖安全检查使用 `npm audit --omit=dev`；不得直接运行 `npm audit fix --force`，以免降级 Drizzle Kit。

测试覆盖 Cognito bearer authentication、owner-only durable Personal Agent conversation、202 acceptance、任务幂等/租约/取消/重试终态、流式 Gateway、消息顺序和角色授权、授权撤回后的 plan 失效、fixture fallback、严格的 plan 输出结构/授权/路线/来源/evidence 校验、LLM failure 与 agent-run 记录、Skill schema/allow-list/timeout、callback HMAC/raw-body/timestamp 边界、安全日志、低基数 metrics、audit summary whitelist，以及预订幂等与乱序 callback。

`npm test` 使用 `TEST_DATABASE_URL`，并拒绝非 loopback host，且要求数据库名
或连接的 `search_path` schema 以 `_test` 结尾。默认在本地 `travelagent` 库中
使用隔离的 `travelagent_test` schema；`pretest` 会创建该 schema 并执行迁移。
不得将 `TEST_DATABASE_URL` 指向开发、staging 或 production 数据。integration
tests 只允许在该安全边界内重置测试数据。

## 技术栈

- **运行时：** Node.js 22 LTS + TypeScript
- **框架：** Fastify 5
- **数据库：** PostgreSQL 16 + Drizzle ORM
- **校验：** Zod
- **测试：** Vitest
- **日志：** Pino（结构化、PII 脱敏）
- **部署：** Docker → AWS App Runner（目标）

## 文档

- [ARCHITECTURE.md](./ARCHITECTURE.md) — 系统设计与模块边界
- [API.md](./API.md) — REST API 参考

## 许可证

MIT
