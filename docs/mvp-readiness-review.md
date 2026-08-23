# MVP 就绪度评审

**评审日期：** 2026-08-23
**范围：** `apps/api`，当前 TypeScript 后端 MVP

## 结论

该架构方向适合 Hackathon：TypeScript/Fastify 模块化单体、作为权威记录的 PostgreSQL、以 fixture 支撑的提供方适配器和模型网关，均可作为继续开发的合适基础。

当前实现**尚未达到可演示或可安全使用的标准**。它可以构建并通过类型检查，但由于 PostgreSQL 和本地 Docker daemon 均不可用，未执行依赖数据库的测试。更重要的是，若干已实现路径不符合文档中的隐私与规划要求。

## 演示前必须修复

1. **规划所有已配置候选。** `planning.ts` 当前只选第一个目的地，未比较已配置的两个或三个候选。
2. **签证检查必须使用快照。** `visa-service.ts` 在国籍授权后代入 `US`；它必须从不可变约束快照读取成员已授权国籍，绝不推断或替代。
3. **授权变化后立即失效。** 授予/撤回必须原子性地使所有受影响的有效方案和确认过期；当前 consent service 仅修改授权行。
4. **根据持久化行程数据重规划。** `change-event-service.ts` 当前硬编码 Tokyo、San Francisco、Shanghai 和日期；它必须使用受影响行程和事件数据，并持久化真实的候选/约束 diff。
5. **保护沙箱 callback。** 当前 callback 接受任意已认证演示用户，且未校验提供方签名/密钥。应提供独立的已认证提供方边界，并确认其关联预期执行。
6. **加入关系唯一性与事务。** 每用户一个 profile；行程成员、`(trip_id, version)` 快照/方案、`(plan_id, user_id)` 确认和每个编排请求的 booking 均须唯一。状态迁移与幂等记录创建须放入事务。
7. **使 seed 与迁移可重复。** 当前 seed 重跑会插入重复演示用户，迁移是无历史的命令式启动代码。改为版本化迁移与幂等 seed upsert。
8. **恢复质量门禁。** 增加 ESLint flat 配置，并在 CI 对可丢弃 PostgreSQL 执行完整测试。实现文档所述 OpenTelemetry/metrics 集成，或在实现前降低文档声明。

## 已执行验证

| 检查项 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run build` | 通过 |
| `npm test` | 失败：`127.0.0.1:5432` 拒绝数据库连接；安装失败后跳过 12 个集成测试，另有 3 个 API 测试因相同原因返回 500。 |
| `npm run lint` | 失败：缺少 ESLint 9 配置文件。 |
| Docker 支撑的验证 | 未运行：本地 Docker daemon 不可用。 |

## 仓库清理

已移除过时的 Coze/Python 脚手架：`.coze`、`pyproject.toml`、`uv.lock` 以及旧根目录的 `src/`、`scripts/` 文件。可部署后端保留在 `apps/api/`，符合单体仓库惯例。空的旧目录不受 Git 跟踪；若文件浏览器仍显示它们，开发者可在本地移除。
