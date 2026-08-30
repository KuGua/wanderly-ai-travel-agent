# 运行时数据与模型策略

生产与开发产品路径只使用已认证用户输入、数据库权威状态和已配置供应商的可验证结果。机票搜索通过 `FLIGHT_PROVIDER` 显式选择一个 live adapter：Amadeus 或 FlightAPI.io；缺少、未知或缺少所选 provider 凭据时 fail closed，绝不自动切换或回退。Amadeus Test 仅用于开发集成验证，不能作为产品运行路径的实时结果。FlightAPI.io 在本地/hackathon E2E 中使用真实免费 credits，自动化测试必须 mock HTTP。系统不提供 Demo 用户、本地行程、静态机酒交通价格、静态签证结论或本地模型回退。

Activities 与 Flight 是相互独立的 typed port：Flight 使用 Amadeus OAuth adapter；Activities 使用当前无需凭据的 Viator 官方 Experiences MCP adapter，分别拥有独立的覆盖矩阵、stale 触发器、evidence 写入、不可用语义、audit action 与 provider 指标。Activities 只接受服务端 immutable snapshot 中的 destination/date authority 与固定 theme allow-list；不得接收浏览器或模型坐标、自由查询、provider URL 或 session ID。MCP 的 click-off link、raw payload 和没有明确币种的 `fromPrice` 必须在 adapter 边界丢弃。失败、超时、限流、空数据或 schema drift 统一返回 `UNAVAILABLE`，不创建 `ACTIVE` plan、虚构 offer、预订参考号或签证资格结论；可创建不含 offer/raw payload、不可确认且不可 booking 的 `RESEARCH_UNAVAILABLE` 缺失摘要，也不得以 fixture、Demo data 或模型编造的内容替代。公开 MCP 未公布固定配额或 SLA，因此默认关闭并严格 fail closed。

地面出行采用三个互不替代的 typed port：`PlaceResolver`（关键词 POI 候选）、`NavigationProvider`（路线、距离、时长与步骤）和 `MobilityOfferProvider`（接送/出租车/包车/租车的商业报价）；`TransitJourneyProvider` 仅在选定可信 provider 后实现。ORS Place/POI 与 Directions 的输入只能来自当前 Shared planning task 的 destination reference、run-bound candidate 或已授权 `TripPlace`，模型和浏览器均不得提交坐标、地址、provider、profile、URL 或原始请求。关键词、地点名称、地址、坐标、route geometry 和步骤正文均是受保护 Trip 数据，不得进入日志、metric label、trace attribute 或 audit summary。路线 evidence 不是商业 offer，不得伪造价格/库存；Amadeus Transfer Search 的估价必须显式标记，booking link 不得透传。任一地面 provider 的 `UNAVAILABLE` 只形成 `COMPLETED_WITH_GAPS` research summary，不取消其他 research；只有用户选择的、仍有效的 live commercial offer 才可进入相应确认/booking sandbox 门禁。

唯一的公共生成内容例外是稳定地图地点的短介绍：它只能由已配置的真实模型根据服务端版本化地点目录和 locale 生成，并以 PostgreSQL 中 7 天 TTL 的非个性化缓存复用。它不是 provider 或旅行事实，输入、缓存键、日志、trace、metric label 和持久化记录不得含用户、Profile、Trip、私聊、原始坐标或客户端地点名称；`INSPIRATION` 和任意坐标不适用该能力。模型或校验失败时返回不可用，不缓存替代内容。

旅行 provider 或模型不可用、超时、限流、返回空数据或输出无法验证时，服务必须记录安全的失败遥测并返回 `UNAVAILABLE`；不得创建 plan、offer、source evidence、预订参考号或签证资格结论，也不得以 fixture、Demo data 或模型编造的内容替代。

全球 visa/entry readiness 只能通过服务端受审查的 typed `VisaProvider` 使用当前 `constraint_snapshot` 中已授权的最小国籍字段。候选阶段仅检查目的地，未选择具体 flight offer 时必须显示 route/transit check pending；路线阶段只由服务端从当前、未过期的 normalized flight segments 构造目的地和中转节点。国籍、证件、原始 provider response、URL query 与申请/购买链接不得进入浏览器 provider 调用、团队 DTO、共享 plan explanation、客户端持久状态、日志、trace、metric label 或 audit summary。未配置 provider、合同/DPA 未验证、provider 失败、机场映射失败或证据过期均为 `UNAVAILABLE`/`STALE`，并仅向成员显示官方核验下一步；不得用 RAG、网页抓取或静态规则库替代。

测试可在 test-only 路径使用依赖注入的 fake provider 或 fake model。测试数据不得被产品源码导入、打包或由环境变量启用。
