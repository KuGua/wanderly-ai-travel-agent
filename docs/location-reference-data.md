# 离线地图位置参考数据

## 目的与边界

`POST /api/v1/explore/location-reference` 将用户**明确点击**的坐标解析为匿名、只读的地图位置参考。它不是地址服务、旅行 provider 或业务真相：结果不能创建目的地候选、私有灵感持久化、共享约束、plan、价格、库存、签证或预订结论。它是唯一不要求 Cognito access token 的 API 路径；其他私有或会改变状态的 API 仍需认证。

坐标只在当前服务端请求内使用。不得写入数据库、audit、日志、trace、指标标签、客户端持久化或长上下文 prompt。地图拖动、缩放、hover 与批量预取不得调用该端点。

为避免匿名滥用，每个 API 进程对每个客户端地址限制为每分钟 30 次。限流键是进程随机盐生成的哈希，仅在一分钟窗口内保存在内存中，不记录原始地址或坐标；超过限制返回 `429`。该 MVP 限制不跨多实例共享，生产多实例部署必须由网关/CDN 提供共享限流。

## 当前版本化资源

- 国家：仓库内 `apps/web/public/map-data/natural-earth-admin-0.geojson`，Natural Earth 1:110m Admin 0；用于国家级 point-in-polygon 参考。
- 省/州：`apps/api/data/location-reference/admin1.geojson`，Natural Earth Admin 1 States, Provinces；仅在已匹配国家内查询一级行政区。
- 城市：`apps/api/data/location-reference/cities5000.txt`，GeoNames `cities5000`（主要城市与行政中心，CC BY 4.0）；运行时保留人口至少 50,000 或行政中心的记录，避免把相邻小聚落显示为主要城市。
- 清单：`apps/api/data/location-reference/source-manifest.json`，记录数据版本、检查时间、来源、许可证与限制。

若未来要覆盖偏远小型聚落，可升级至 GeoNames `cities500`；这会显著增大数据与索引体积。更新数据必须保留 source manifest、更新检查时间、运行 resolver 测试，并人工核对页面/文档 attribution。

## 结果与失败行为

在匹配到国家时，返回 `REFERENCE`、可选省/州和可选最近城市。最近城市超过 75 km 时必须省略，不能把“最近城市”称作行政归属。海洋、未覆盖区域返回 `NO_REFERENCE`；超过匿名限流返回 `429`；数据文件无法读取或验证时返回 `503`，不推断结果。

地图底图的可渲染标签和 SVG overlay 不参与该解析流程。它们是视觉层，不能成为来源或 fallback。
