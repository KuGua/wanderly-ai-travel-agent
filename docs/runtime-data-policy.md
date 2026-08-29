# 运行时数据与模型策略

生产与开发产品路径只使用已认证用户输入、数据库权威状态和已配置供应商的可验证结果。Amadeus Test 仅用于开发集成验证，不能作为产品运行路径的数据源。系统不提供 Demo 用户、本地行程、静态机酒交通价格、静态签证结论或本地模型回退。

Amadeus Tours & Activities 与 Amadeus Flight Offers Search 通过注入式 OAuth token provider 复用 client-credentials 与请求 deadline，但两个工具是相互独立的 typed port：分别拥有独立的 provider adapter、覆盖矩阵、stale 触发器、evidence 写入、不可用语义与 audit action。两者必须以 per-endpoint 限流隔离分配，以免任一方耗尽共享配额导致另一方连带失败。Activities 只使用服务端版本化 destination reference 的坐标/半径与固定 theme allow-list；不得接收浏览器或模型坐标，也不得展示、持久化或透传 provider booking link。失败、超时、限流、空数据统一返回 `UNAVAILABLE`，不创建 `ACTIVE` plan、offer、source evidence、预订参考号或签证资格结论；可创建不含 offer/raw payload、不可确认且不可 booking 的 `RESEARCH_UNAVAILABLE` 缺失摘要，也不得以 fixture、Demo data 或模型编造的内容替代。

地面出行采用三个互不替代的 typed port：`PlaceResolver`（关键词 POI 候选）、`NavigationProvider`（路线、距离、时长与步骤）和 `MobilityOfferProvider`（接送/出租车/包车/租车的商业报价）；`TransitJourneyProvider` 仅在选定可信 provider 后实现。ORS Place/POI 与 Directions 的输入只能来自当前 Shared planning task 的 destination reference、run-bound candidate 或已授权 `TripPlace`，模型和浏览器均不得提交坐标、地址、provider、profile、URL 或原始请求。关键词、地点名称、地址、坐标、route geometry 和步骤正文均是受保护 Trip 数据，不得进入日志、metric label、trace attribute 或 audit summary。路线 evidence 不是商业 offer，不得伪造价格/库存；Amadeus Transfer Search 的估价必须显式标记，booking link 不得透传。任一地面 provider 的 `UNAVAILABLE` 只形成 `COMPLETED_WITH_GAPS` research summary，不取消其他 research；只有用户选择的、仍有效的 live commercial offer 才可进入相应确认/booking sandbox 门禁。

唯一的公共生成内容例外是稳定地图地点的短介绍：它只能由已配置的真实模型根据服务端版本化地点目录和 locale 生成，并以 PostgreSQL 中 7 天 TTL 的非个性化缓存复用。它不是 provider 或旅行事实，输入、缓存键、日志、trace、metric label 和持久化记录不得含用户、Profile、Trip、私聊、原始坐标或客户端地点名称；`INSPIRATION` 和任意坐标不适用该能力。模型或校验失败时返回不可用，不缓存替代内容。

旅行 provider 或模型不可用、超时、限流、返回空数据或输出无法验证时，服务必须记录安全的失败遥测并返回 `UNAVAILABLE`；不得创建 plan、offer、source evidence、预订参考号或签证资格结论，也不得以 fixture、Demo data 或模型编造的内容替代。

测试可在 test-only 路径使用依赖注入的 fake provider 或 fake model。测试数据不得被产品源码导入、打包或由环境变量启用。
