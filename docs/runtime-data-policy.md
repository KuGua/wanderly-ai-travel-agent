# 运行时数据与模型策略

生产与开发产品路径只使用已认证用户输入、数据库权威状态和已配置供应商的可验证结果。机票搜索通过 `FLIGHT_PROVIDER` 显式选择一个 live adapter：Amadeus 或 FlightAPI.io；缺少、未知或缺少所选 provider 凭据时 fail closed，绝不自动切换或回退。Amadeus Test 仅用于开发集成验证，不能作为产品运行路径的实时结果。FlightAPI.io 在本地/hackathon E2E 中使用真实免费 credits，自动化测试必须 mock HTTP。系统不提供 Demo 用户、本地行程、静态机酒交通价格、静态签证结论或本地模型回退。

唯一的公共生成内容例外是稳定地图地点的短介绍：它只能由已配置的真实模型根据服务端版本化地点目录和 locale 生成，并以 PostgreSQL 中 7 天 TTL 的非个性化缓存复用。它不是 provider 或旅行事实，输入、缓存键、日志、trace、metric label 和持久化记录不得含用户、Profile、Trip、私聊、原始坐标或客户端地点名称；`INSPIRATION` 和任意坐标不适用该能力。模型或校验失败时返回不可用，不缓存替代内容。

旅行 provider 或模型不可用、超时、限流、返回空数据或输出无法验证时，服务必须记录安全的失败遥测并返回 `UNAVAILABLE`；不得创建 plan、offer、source evidence、预订参考号或签证资格结论，也不得以 fixture、Demo data 或模型编造的内容替代。

测试可在 test-only 路径使用依赖注入的 fake provider 或 fake model。测试数据不得被产品源码导入、打包或由环境变量启用。
