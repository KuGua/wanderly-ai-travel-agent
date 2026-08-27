# 离线地图位置参考数据

## 目的与边界

`POST /api/v1/explore/location-reference` 将用户**明确点击**的坐标解析为匿名、只读的地图位置参考。它不是地址服务、旅行 provider 或业务真相：结果不能创建目的地候选、私有灵感持久化、共享约束、plan、价格、库存、签证或预订结论。它是唯一不要求 Cognito access token 的 API 路径；其他私有或会改变状态的 API 仍需认证。

坐标只在当前服务端请求内使用。不得写入数据库、audit、日志、trace、指标标签、客户端持久化或长上下文 prompt。地图拖动、缩放、hover 与批量预取不得调用该端点。

为避免匿名滥用，每个 API 进程对每个客户端地址限制为每分钟 30 次。限流键是进程随机盐生成的哈希，仅在一分钟窗口内保存在内存中，不记录原始地址或坐标；超过限制返回 `429`。该 MVP 限制不跨多实例共享，生产多实例部署必须由网关/CDN 提供共享限流。

## 当前版本化资源

- 国家：`apps/api/data/location-reference/countries.geojson`，由 `apps/api/scripts/build-country-reference.mjs` 从 Natural Earth 1:10m Admin 0（v5.1.2，与前端边界 mesh 同源同版本）生成，仅保留 `ADMIN`、`ISO_A2`、`ADM0_A3`、`NAME_EN`、`NAME_ZH`、`LABEL_X/Y`、`LABELRANK` 与 bbox；用于国家级 point-in-polygon 参考，同时作为前端国家标签锚点来源。1:110m 版本不含新加坡、马耳他、摩纳哥、巴林、香港、澳门等微型行政体，会把这些坐标错判成邻国，因此不得再用于该 resolver。Natural Earth 对 France、Norway 等条目的 `ISO_A2` 记为 `-99`，构建脚本回落到 `ISO_A2_EH`，否则会丢失其省/州与最近城市。
- 省/州：`apps/api/data/location-reference/admin1.geojson`，Natural Earth Admin 1 States, Provinces；仅在已匹配国家内查询一级行政区。
- 城市：`apps/api/data/location-reference/cities5000.txt`，GeoNames `cities5000`（主要城市、区县、街区与行政中心，CC BY 4.0）。版本化原始文件完整保留，区县和街区记录不会删除，供未来功能使用；当前地图只建立市级运行时投影：接受 `PPL`、`PPLA`、`PPLA2`、`PPLC`，排除 `PPLA3`、`PPLA4`、`PPLA5`、`PPLX` 等更细层级。同一二级行政区域存在市级行政中心时，普通 `PPL` 也折叠到该市中心；若普通聚落缺失二级行政代码，但同一一级行政区 75 km 内存在明确市级中心，也使用该市中心。不同市级行政区（例如南京与苏州）保持独立。
- 清单：`apps/api/data/location-reference/source-manifest.json`，记录数据版本、检查时间、来源、许可证与限制。

若未来要覆盖偏远小型聚落，可升级至 GeoNames `cities500`；这会显著增大数据与索引体积。更新数据必须保留 source manifest、更新检查时间、运行 resolver 测试，并人工核对页面/文档 attribution。

## 结果与失败行为

在匹配到国家时，返回 `REFERENCE`、可选省/州和可选最近城市。Natural Earth Admin 0 不收录圣淘沙一类的离岸小岛与填海地块，因此坐标不落在任何国家多边形内时，只在 10 km 容差内回退到最近的国家多边形；容差外（公海、无覆盖区域）仍返回 `NO_REFERENCE`，不推断。容差回退的结果与多边形命中同为位置参考，不得解释成行政归属、边界主张或地址。命中城市时同时返回 `nearestCityCoordinates`，其值是市级运行时投影中同一条 GeoNames 索引记录的中心点；区、县、街道和街区不得成为地图 pin 的名称或中心点，但原始记录仍保留在版本化数据中。前端只可用市级结果把当前会话图钉归一到城市中心和做同城去重，不能把它解释成行政边界、精确地址或导航点。最近城市超过 75 km 时，城市名称、中心点与距离必须同时为 `null`，不能把“最近城市”称作行政归属。海洋、未覆盖区域返回 `NO_REFERENCE`；超过匿名限流返回 `429`；数据文件无法读取或验证时返回 `503`，不推断结果。

地图底图的可渲染标签和 SVG overlay 不参与坐标反向解析流程。它们是视觉层，不能成为该 resolver 的来源或 fallback。前端可以读取同仓库的主要城市标签目录识别聊天文本中明确出现的城市名称并移动视口，但该行为只创建当前会话灵感，不得生成旅行事实或替代服务端位置参考。

## 解析源模式

`apps/api/src/location-reference/location-reference-source.ts` 在进程启动时按 `LOCATION_REFERENCE_MODE` 选择解析源，公开 API 与内部 `policy/conversation-safety.ts` 共用同一抽象：

| 模式 | 行为 | 数据所在 |
|---|---|---|
| `in-process` | 直接调用 `getLocationReferenceResolver()`。默认；与重构前等价。 | API 进程内存（约 300 MB） |
| `sidecar` | HTTP `POST /resolve` 到 `${LOCATION_REFERENCE_SIDECAR_URL}`，超时 `LOCATION_REFERENCE_SIDECAR_TIMEOUT_MS`（默认 2000）。 | 独立容器 |
| `disabled` | 同步返回 `{ outcome: "NO_REFERENCE", ... }`，不读取任何数据文件。 | n/a |

`sidecar` 仅供本地 dev 使用，不绑定公网、不加鉴权、不导出 OTel。`disabled` 模式用于 16 GB Mac 端到端演示：跳过 70 MB GeoJSON 加载，公开端点返回 `NO_REFERENCE`，内部聊天路径降级为 `sourceType: "INSPIRATION"`。详见 `apps/api/src/location-reference/SIDECAR.md` 的失败模式表与可观测性缺口说明。
