# Wanderly AWS 部署手册

本手册部署现有架构，不迁移业务框架，也不使用 Amazon Bedrock。基础设施由 `infra/` 中的 AWS CDK v2（TypeScript）管理，目标区域固定为 `us-east-1`。

## 部署拓扑

- Next.js：AWS Amplify Hosting（需要仓库连接，单独配置）。
- Fastify API：AWS App Runner，最小 `0.25 vCPU / 1 GB`。
- Durable Worker：ECS Fargate，单个 `0.25 vCPU / 512 MB` task。
- PostgreSQL：RDS PostgreSQL `db.t4g.micro`、20 GiB gp3、Single-AZ、私有子网、存储加密。
- 身份与密钥：Cognito、Secrets Manager、KMS。
- 网络：两可用区、一个 NAT Gateway；数据库位于 isolated subnets。

App Runner 与 Worker 使用同一个版本化容器镜像。模型 provider 为 Gemini，`MODEL_GATEWAY_API_KEY` 只从 Secrets Manager 注入；不得写入仓库、CloudFormation 参数、日志或前端配置。
AWS runtime 固定设置 `DB_SSL_MODE=require`，使 API、Worker 与 migration 使用 RDS 要求的加密 PostgreSQL 连接；本地示例保持 `disable`。

## 费用边界

该拓扑是对现有运行逻辑改动最小的演示环境，不是 20 美元/月的常驻方案。`us-east-1` 的实际账单以 AWS Billing 为准；NAT Gateway、RDS、Fargate、App Runner、Secrets Manager、KMS、存储和数据传输都会产生费用。应将部署限制在活动演示窗口内，并设置预算告警。20 美元只能作为短期体验额度，不应把它当作完整月度预算。

## 前置条件

1. AWS 账号允许创建 CloudFormation、IAM、VPC、RDS、ECR、App Runner、ECS、Cognito、Secrets Manager 和 KMS 资源。
2. 本地或 AWS CloudShell 可运行 Node.js、npm、Docker 与 AWS CLI。
3. 已准备 Gemini API key，但不把 key 粘贴到命令历史。推荐在 Secrets Manager 控制台中编辑 `ai-travel-agent/model-gateway-api-key`。

## 验证与部署

API 镜像采用单阶段编译，并在编译后执行 `npm prune --omit=dev`。最终运行时仍只保留生产依赖，同时降低 AWS CloudShell 构建期间的 Docker 磁盘峰值。

```bash
cd infra
npm ci
npm run build
npm test
npm run synth
npx cdk bootstrap aws://ACCOUNT_ID/us-east-1
npx cdk deploy AiTravelFoundation --require-approval never
```

在 Secrets Manager 控制台中把 `ai-travel-agent/model-gateway-api-key` 的随机占位值替换为真实 Gemini API key 后部署运行栈：

```bash
npx cdk deploy AiTravelRuntime --require-approval never
```

首次部署必须在同一 VPC 中运行一次数据库 migration。可用已生成的 Fargate task definition 覆盖容器命令为：

```text
node dist/db/migrate.js
```

等待 migration task 成功退出后，确认 Worker service 达到 `1/1`，再检查 App Runner 输出 URL 的 `/health`。任何 migration 失败都必须先停止发布并查看该 task 的 CloudWatch Logs，不能把未迁移数据库视为健康部署。

## Web 配置

Amplify 的生产构建至少需要以下公开变量；值从两个 CDK stack outputs 取得：

```dotenv
NEXT_PUBLIC_AUTH_MODE=cognito
NEXT_PUBLIC_COGNITO_USER_POOL_ID=<user-pool-id>
NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID=<web-client-id>
NEXT_PUBLIC_API_BASE_URL=<app-runner-url>
```

这些变量可以暴露给浏览器，但任何数据库密码、模型 key、provider key、JWT、Cookie 或 HMAC secret 都不得使用 `NEXT_PUBLIC_` 前缀。

## 停机、回滚与删除

- 应用失败：先回滚 App Runner/ECS 到前一镜像；数据库 schema 不自动回滚。
- 节省费用：演示结束后删除 Runtime stack；NAT Gateway 属于 Foundation stack，只有删除 Foundation 才停止 NAT 计费。
- 删除 Runtime 后再删除 Foundation。RDS 使用 snapshot removal policy，KMS key 与 Cognito user pool 默认保留，因此仍需在控制台核对残留和费用。
- CloudFormation 删除前导出需要保留的数据；不得通过删除栈代替数据库迁移回滚。

## 已知限制

- 当前只开一个 NAT Gateway，AZ 故障时无冗余，适用于工程原型，不适用于生产 SLA。
- Worker 固定一个 task；数据库租约保证逻辑不依赖单副本，但此配置没有高可用余量。
- OpenTelemetry export 暂时关闭，仍保留结构化 CloudWatch logs；上线前应补齐 dashboard、alarm 与 trace exporter。
- Amplify 仓库授权是独立的第三方 OAuth 操作，不由 CDK 自动完成。
