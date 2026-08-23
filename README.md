# AI Travel Agent（AI 旅行助手）

面向 Hackathon 的 MVP：基于明确授权的多人国际旅行协同规划。

## 仓库结构

- `apps/api/` — TypeScript/Fastify 后端 MVP、PostgreSQL schema、fixture 和测试。`apps/` 是单体仓库中可部署应用的惯用目录；`api` 为后端服务。
- `docs/` — 产品需求、交付 backlog 和测试场景。
- `docs/frontend-ui-plan.md` — 登录后 UI 地图、前端技术栈决策与 API 就绪度方案。
- `TECH_STACK.md` — 前后端、Agent、数据、AWS 部署与安全边界的推荐技术栈记录。

## 运行后端

```bash
cd apps/api
npm install
cp .env.example .env
docker compose up -d postgres
npm run db:migrate
npm run db:seed
npm run dev
```

API 地址为 `http://localhost:3000`；OpenAPI 文档位于 `/docs`。
更多信息见 [后端 README](apps/api/README.md)、[架构说明](apps/api/ARCHITECTURE.md) 和 [API 参考](apps/api/API.md)。
实现 Web 客户端前请先阅读 [前端 UI 方案](docs/frontend-ui-plan.md) 和 [技术栈记录](TECH_STACK.md)。
