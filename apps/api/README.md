# AI Travel Agent — 后端 MVP

> Hackathon 项目：基于授权数据共享、fixture 数据提供方和预订沙箱的国际旅行协同规划。

## 快速开始

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

# 5. 写入演示数据
npm run db:seed

# 6. 启动服务器
npm run dev
```

服务器运行于 `http://localhost:3000`；OpenAPI 文档位于 `http://localhost:3000/docs`。

## LLM 配置

模型调用只在 API 服务端进行。默认 `MODEL_GATEWAY_PROVIDER=mock`，因此 fixture
演示不依赖外部模型。要启用 Gemini，请在 `.env` 中设置：

```dotenv
MODEL_GATEWAY_PROVIDER=gemini
GEMINI_API_KEY=your_gemini_key
GEMINI_MODEL=gemini-2.5-flash
```

也可选择 `MODEL_GATEWAY_PROVIDER=openai` 并设置 `OPENAI_API_KEY`，或选择
`openai-compatible` 并设置 `MODEL_GATEWAY_API_KEY`、`MODEL_GATEWAY_BASE_URL` 和
`MODEL_GATEWAY_MODEL`。后者适用于提供 OpenAI Chat Completions 兼容接口的服务。
原生 API 不兼容该接口的供应商需要单独 provider adapter，不能仅靠更换 key 启用。
不要将密钥提交到仓库或暴露给浏览器。

## 演示用户

| 用户 | 外部 ID | 出发城市 | 关键特征 |
|-------|------------|----------------|------------|
| Alice | `alice` | San Francisco | 艺术兴趣、市中心住宿、**不乘红眼航班** |
| Bob | `bob` | San Francisco | 预算上限 $2500、舒适度偏好 |
| Chen | `chen` | Shanghai | 历史/寺庙、出发日期受限 |

使用 `X-Demo-User` header 进行演示认证：
```bash
curl -H "X-Demo-User: alice" http://localhost:3000/api/v1/profiles/me
```

演示身份选择可先调用无需认证的 `GET /api/v1/demo/users`；该接口只返回
seeded user UUID、`externalId` 和 `displayName`。已选择身份后，其他业务接口
必须携带 `X-Demo-User`。

## 核心能力

- **Profile CRUD** — 默认私密；未经明确授权绝不共享。
- **共享行程管理** — 创建行程、邀请成员、管理目的地。
- **基于授权的数据共享** — 按字段、范围和行程授予/撤回授权。
- **约束快照** — 每轮规划使用不可变的已授权数据快照。
- **Fixture 提供方** — 所有航班/住宿/地面交通/签证数据均标记为 `Demo data`；fixture 具有显式版本和固定采集时间，航班查询会按路线和请求日期范围过滤。
- **规划控制平面** — `ModelGateway` 输出在写入前必须通过严格结构、snapshot 字段授权、路线边界、来源完整性与 provider evidence 精确匹配校验；失败返回 correlation-aware `422`，且不创建 plan。
- **Model/Skill integration** — `gateway-factory.ts` 在 `MockModelGateway` 与 Gemini、OpenAI 或任意 OpenAI-compatible `LLMGateway` 间选择；LLM 路径记录 model/prompt version 和 agent run，并在失败时确定性 fallback。结构化 Skill/model output 始终只是 candidate，仍须通过最终控制平面校验。
- **入境准备** — 每位成员各有清单；国籍未共享时显示“请向官方来源核验”。
- **方案版本管理** — 生成、过期、带差异的重规划。
- **三人确认** — 三位必需成员全部确认后，才可进行预订沙箱。
- **预订沙箱** — 不发生真实付款；返回演示参考号。
- **幂等性** — 规划、变化事件和预订操作均为幂等。
- **审计轨迹** — 所有敏感操作均以关联 ID 记录。

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

测试覆盖安全 demo identity、授权撤回后的 plan 失效、fixture fallback、严格的 plan 输出结构/授权/路线/来源/evidence 校验、LLM fallback 与 agent-run 记录、Skill schema/allow-list/timeout，以及预订幂等与乱序 callback。

`npm test` 需要按“快速开始”完成本地 PostgreSQL migration；integration tests 会重置测试用 trip/session 数据。

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
