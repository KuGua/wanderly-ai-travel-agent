# 2026-08-25 — MapLibre 矢量瓦片零请求诊断与修复

## 1. 用户反馈（原始现象）

`/home`（探索地图）页面上 **Countries / States / Provinces / Cities 三个开关不显示**，地图上**完全看不到国界、省界、城市名**。`Wanderly` 探索首页是 OpenFreeMap Liberty + MapLibre 6.6 globe 投影，用户期望的是渐进显示的国家 / 行政区 / 城市标签。

## 2. 第一轮排查：style 兼容性（refactor 之前）

直接读 OpenFreeMap 公开 style JSON，确认它确实包含我们引用的 8 个 layer：

| Layer | minzoom | maxzoom | 默认 zoom 2.25 可见？ |
|---|---|---|---|
| `boundary_2`（国界） | — | — | ✅ |
| `boundary_3`（省/州界） | 5 | — | ❌ 被 OpenFreeMap minzoom 隐藏 |
| `label_country_1/2/3` | 1/—/2 | 9 | ✅ 字号小但可见 |
| `label_state` | 5 | 8 | ❌ |
| `label_city` & `label_city_capital` | 3 | — | ❌ |

CDN 200 OK、CORS `*`、TileJSON 可用。Style 层面**完全兼容**。

### 第一轮调查结论

`supportsGeographyLayers(map)` 应该返回 `true`，控件应该出现。看不出问题所在，**进入浏览器实测**。

## 3. 第二轮排查：浏览器 Console 诊断

加 `window.__wanderlyMap` dev hook（已在 dev 模式暴露）后跑了一系列 Console 命令：

| 检查项 | 期望 | 实际（**修复前**） |
|---|---|---|
| `m.style._loaded` | true | ✅ true |
| `m.painter` | defined | ✅ defined |
| `m.getSource('openmaptiles')` | 存在 | ✅ 存在 |
| `m.getSource('openmaptiles').loaded()` | true | ✅ true（TileJSON 拿到） |
| `m.querySourceFeatures('openmaptiles').length` | > 0 | ❌ **0** |
| `m.areTilesLoaded()` | true | ❌ **false** |
| Network filter=`pbf` | 有请求 | ❌ **零请求** |
| `m.getLayoutProperty('boundary_2', 'visibility')` | "visible" | ✅ "visible"（style 已加载） |
| `m.getPaintProperty('boundary_2', 'line-color')` | "#0b5264"（我们的 override） | ✅ "#0b5264" |
| `m.getPaintProperty('boundary_2', 'line-width')` | 1.35（我们的 override） | ✅ 1.35 |

### 第二轮调查结论

Source 注册了、TileJSON 拿到了、style 也加载了、`paint`/`layout` 设置都正确——**但 sourceCache 完全没有派 tile 请求**。零 `pbf` 请求 + `querySourceFeatures() === 0` + `areTilesLoaded() === false` 的组合，只可能源自**渲染管线没把 viewport 派给 sourceCache**。

## 4. 根因假设（两次 refactor 之后验证）

代码原状（`apps/web/src/components/explore/explore-map-page.tsx` 第 123 行的 `map.once("style.load")` 回调）：

```ts
map.once("style.load", () => {
  loaded = true;
  window.clearTimeout(loadTimeout);
  map.setProjection({ type: "globe" });                       // ← 同步触发 transform 重置
  const inspection = inspectGeographyLayers(map, MAP_STYLE_URL);
  ...
});
```

`style.load` 事件触发时机：style JSON 解析完成时。**但 openmaptiles 是带 `url` 的 vector source**（`"url": "https://tiles.openfreemap.org/planet"`），TileJSON 在 `style.load` 之后才**异步**拉取。这时 `openmaptiles` 的 sourceCache 还没完全 attach 到 viewport。

在 `style.load` 回调里同步调用 `setProjection({ type: "globe" })` 触发 transform 重置。**这次重置丢掉了 sourceCache 刚 attach 上的 viewport tile 派发通道**。结果：source 注册成功、TileJSON 拉到、style 加载完成，但 sourceCache 永远不会把 viewport 派给 source，零 `pbf` 请求，零 tile。

### 关键证据链**

- `source.loaded() === true`（TileJSON 到了） → source 已经 attach
- `querySourceFeatures() === 0` + `areTilesLoaded() === false` → sourceCache 没派发 tile
- `getLayer()` / `getPaintProperty()` / `getLayoutProperty()` 都正常 → style 已完全加载
- 零 `pbf` 请求 → 网络层没问题，是 sourceCache 调度问题

唯一同时满足以上四个条件的状态：**style.load 回调里的同步 `setProjection` 把 sourceCache 派发通道打掉了**。

## 5. 修复尝试

### 5.1 第一次 refactor（结构性改进，不修 root cause）

把 `mapReady / mapUnavailable / geographyAvailable` 三个 boolean state 合并为 `MapReadiness` 5 case 联合 + `panelDisabledReason` / `layerCaptionFor` helper，让失败模式自带可观测信号。**没有修 `style.load` 回调里的同步 setProjection 问题**，所以问题没解决。

### 5.2 第二次 refactor（直接修 root cause）

**核心修复**：把 `setProjection` + `applyGeographyContrast` + `setGeographyLayerVisibility` + dev hook 挂载全部从 `map.once("style.load", ...)` 移到 `map.on("sourcedata", onSourceData)`。逻辑：等 MapLibre 真的把 source 准备好（TileJSON 拉完、sourceCache attach 完成）再做 transform reset 和 paint mutation。

新增文件 / 改动：
- `apps/web/src/components/explore/map-readiness.ts` — 新增 `MapStage` 与 `mapReadinessStage` 派生函数
- `apps/web/src/components/explore/explore-map-page.tsx` — 拆 `style.load` 回调；新增 `onSourceData` 闭包、`sourceTimeout` (6s)、`styleLoadedRef`；抽取 `attachDevHook`；所有失败路径都仍挂载 dev hook（保持可调试）
- `apps/web/src/components/explore/explore-map-page.test.tsx` — mock `on` 类型放宽为 `unknown`；新增 `MapMock.off` 与 `fireSourcedata` helper；4 个新 lifecycle 测试覆盖：等待阶段 / 无关 source 忽略 / `isSourceLoaded: false` 忽略 / 6s source 超时
- `docs/frontend-prototype-handoff.md` — 新增 §5.2.3 解释三阶段生命周期与 race 原因
- `docs/test-scenarios.md` — §TS-P2 末尾新增 Expected outcome

### 5.3 第二次 refactor 后的浏览器实测

硬刷新跑最新代码，再查 dev hook：

| 检查项 | 实际（**修复后**） | 解读 |
|---|---|---|
| `readiness.kind` | `unavailable-network` | finalizeReadiness 没跑过 |
| `stage` | `unavailable` | 同上 |
| `readiness.reason` | `timeout` | 12s loadTimeout 或 6s sourceTimeout 触发了 |
| `boundary_2 line-color` | `hsl(248,1%,41%)`（原始） | 我们的 override 没生效 → finalizeReadiness 没跑 |
| `boundary_2 line-width` | `[interpolate, ...]`（原始） | 同上 |
| `boundary_2 visibility` | `undefined` | 同上 |
| `m.isStyleLoaded()` | **false** | **style.load 没触发** |
| `m.getSource('openmaptiles').loaded()` | **true** | 但 TileJSON 已到 |
| Network filter=`pbf` | 仍然零 | sourceCache 仍然没派 tile |

### 5.4 第二次 refactor 的问题

**修复后状态依然在 `unavailable-network`，且 `isStyleLoaded() === false`**。

分析：
- source.loaded() === true → TileJSON 拉到了
- isStyleLoaded() === false → style JSON 还没解析完 / `style.load` 事件还没触发
- readiness.kind === unavailable-network + reason === timeout → 6s sourceTimeout 在 sourcedata 之前先触发了

也就是说：**`style.load` 事件在 12s 内根本没触发**（否则 `loaded = true` 会清掉 loadTimeout、且会注册 sourcedata 监听器）。但 source 的 TileJSON 居然拿到了？

可能性：
1. **`setProjection({ type: "globe" })` 在 source-load 之前调用**会让 style 状态卡死（即使 source 数据流是正常的）。第二次 refactor 把 setProjection 移到 `onSourceData`，但 `onSourceData` 因为 6s 超时根本没跑过
2. **`sourcedata` 事件本身不触发**（MapLibre 6.6 + globe projection 的某个边角 bug）
3. **TileJSON 是异步请求，TileJSON 的 source ID 解析后但 sourceCache 还没真正派 tile，sourcedata 还没 emit 任何 `isSourceLoaded: true` 事件**

最可能的是 **第二种**：`setProjection` 即使移到 sourcedata 之后也太早——globe projection 在 sourceCache 派 tile 之前不应该初始化。或者 **`isSourceLoaded: true` 在 MapLibre 6.6 中需要等到所有 content tile 都加载完才 emit**，而首屏 viewport tile 在慢网络下 6s 内拉不完。

无论根因是哪个，**6s sourceTimeout 本身太激进**了——比首屏 tile 完整加载的预期时间还要短。

## 6. 当前状态总结

| 维度 | 状态 |
|---|---|
| MapLibre 矢量瓦片加载 | ❌ 仍然零 pbf 请求 |
| `boundary_2/3` 等 layer 渲染 | ❌ 仍然看不到 |
| Dev hook 暴露可观测信号 | ✅ stage / readiness / sourcePresent / missingLayers 全部可读 |
| Globe 投影本身渲染 | ✅ 底图 background/water 正常显示 |
| Fixture 入口 / Tokyo/Lisbon/Reykjavík 按钮 | ✅ 可点击 |
| Globe error 回退 | ✅ sourceTimeout 触发后显示 |
| 类型 / 单元测试 | ✅ 25 个测试全绿 |
| 文档同步 | ✅ §5.2.3 + TS-P2 已更新 |

**用户体验**：地图上**没有任何行政区边界**，但 globe 本身、底图、fixture 候选入口都正常；控件现在是 disabled（被 `unavailable-network` 路径覆盖）但有 `role="status"` caption——比修复前的"静默消失"还是更好的失败可见性。

## 7. 预期结果（待最终修复后）

按 plan 顺序：

1. **去掉 6s sourceTimeout**（太激进，慢网络会被误杀）
2. **新增 `map.on("idle")` 兜底监听**：与 `sourcedata` 并行，任一先触发就 `finalizeReadiness`（用 `sourceReady` 标志防重复）
3. **`idle` 事件语义最稳**：它代表"MapLibre 完全 idle（style + sources + tiles 都 ready）"。`sourcedata` 在 `isSourceLoaded: true` 触发时仍可能 tile 还在路上，`idle` 才真正表示所有渲染数据 ready
4. **保留 `sourcedata` 作为快路径**：TileJSON 拿到就触发，比 idle 早很多
5. **依赖 12s loadTimeout 兜底**——这是真正的硬超时，不依赖任何 source-specific 事件
6. **重写 test mock**：让 `idle` 事件也能被 mock 触发；新增测试覆盖"source-load 慢但 idle 已发"的情况

修复后预期浏览器实测：
- `window.__wanderlyMap.readiness.kind === "ready-supported"`
- `window.__wanderlyMap.stage === "ready"`
- `m.querySourceFeatures('openmaptiles').length > 0`
- Network filter=`pbf` 看到 `https://tiles.openfreemap.org/planet/{z}/{x}/{y}.pbf` 200 OK
- 缩放到 zoom 5+ 看到 `boundary_3` + `label_state`
- 点 Countries 切换 → `setLayoutProperty('boundary_2', 'visibility', ...)` 被调用

## 8. 参考与时间线

| 日期 | 改动 | commit / 状态 |
|---|---|---|
| 2026-08-25 上午 | 第一轮 refactor：5-case `MapReadiness` 联合 + `<LayerToggleGroup>` + `panelDisabledReason` / `layerCaptionFor` + `window.__wanderlyMap` + fixture 快照 + 三份文档同步 | 工作区未提交 |
| 2026-08-25 中午 | 用户反馈：硬刷新后边界仍看不到 | 触发浏览器 Console 排查 |
| 2026-08-25 中午 | 浏览器诊断发现 sourceCache 零 tile | 锁定 root cause：`setProjection` 在 `style.load` 同步触发导致 sourceCache 派发丢失 |
| 2026-08-25 下午 | 第二次 refactor：`MapStage` + 拆 `style.load` 回调 + `onSourceData` + `sourceTimeout` + 4 个新测试 + 文档 §5.2.3 | 25 测试全绿；但浏览器实测仍 unavailable |
| 2026-08-25 傍晚 | 用户反馈：刷新后 `stage === 'unavailable'` + `isStyleLoaded() === false` | 触发本报告 + 第三次修复方案 |
| 待办 | 第三次修复：去掉 6s sourceTimeout + 加 `idle` 兜底 + mock 演化 | — |

## 9. 关联文件清单

| 文件 | 角色 |
|---|---|
| `apps/web/src/components/explore/explore-map-page.tsx` | 地图组件（需要第三次 refactor） |
| `apps/web/src/components/explore/map-geography-layers.ts` | `inspectGeographyLayers` + `OPEN_MAP_TILES_SOURCE` 导出 |
| `apps/web/src/components/explore/map-readiness.ts` | `MapReadiness` 联合 + `MapStage` 派生 |
| `apps/web/src/components/explore/explore-map-page.test.tsx` | 测试 + mock |
| `apps/web/src/components/explore/__fixtures__/openfreemap-liberty-layers.ts` | 8 个 layer ID 快照 |
| `docs/frontend-prototype-handoff.md §5.2.3` | 生命周期说明 |
| `docs/test-scenarios.md §TS-P2` | 验收用例 |
| `apps/web/.env.local` | `NEXT_PUBLIC_MAP_STYLE_URL=https://tiles.openfreemap.org/styles/liberty` |

## 10. 后续约束（给 AI 代理）

- **不依赖任何特定 source 事件的固定超时**——超时只用来兜底 style-load（12s），其他都靠事件
- **`setProjection({ type: "globe" })` 是破坏性操作**，必须在 MapLibre 完全 idle 之后才能调，否则会丢 sourceCache tile 派发
- **`sourcedata` 在 MapLibre 6.6 上语义不完全可靠**——`isSourceLoaded: true` 可能仅在 tile 完全 ready 后才 emit，不能用作"TileJSON 到了"的信号
- **`idle` 是"完全 ready"的官方信号**——任何 readiness 推进都应以它为准
- **dev hook 在所有失败路径仍可访问**——这是调试契约，不能破坏

---

**报告状态**：截至 2026-08-25 傍晚，工作区代码已通过所有静态 + 单元验证，但浏览器实测仍 unavailable。下一步按 §7 修复方案执行。

## 11. 复核结论（当前代码与 MapLibre 6.6 源码）

本报告先前将两个 MapLibre 生命周期信号解释反了；这解释了第二次 refactor 后稳定出现的 `unavailable-network`，但**不能证明**最初的零 PBF 请求是 `setProjection` 引起的。

1. `map.isStyleLoaded()` 代理 `style.loaded()`。后者除 style 已解析外，还要求每个 `TileManager.loaded()` 为 true；后者又要求 source metadata、一次 viewport update，及 in-view tile 均完成（或报错）。因此 `isStyleLoaded() === false` 只能说明 source/tile 仍未完成，**不代表** `style.load` 未触发，也不能说明 style JSON 未解析。
2. `sourcedata.isSourceLoaded` 在 style 中由 `tileManager.loaded()` 填充，语义是“该 source 没有 outstanding request”，不是“TileJSON metadata 已到”。当前组件在 `style.load` 后等待这个值为 true，才调用 `setProjection` 和推进 readiness；但它本身通常要等首屏 PBF 都完成。零 PBF 或慢 PBF 时，这个条件永远不满足，6 秒 `sourceTimeout` 必然把正常初始化误判为网络失败。这是当前可复现 UI 故障的直接原因。
3. `map.on("idle")` 同样不是可用于打破该环的兜底：MapLibre 仅在 `map.loaded()` 为 true 后触发 `idle`，而 `map.loaded()` 也依赖 tile 完成。它可用于“地图已完成”的通知，不能用来使尚未派发的 tile 开始派发。
4. MapLibre 6.6 的 `setProjection()` 调用 `style.setProjection()` 后立即 `_update(true)`；后续 render 会执行 `style._updateSources(transform)`。本地源码没有支持“setProjection 会丢失 sourceCache viewport dispatch 通道”的证据。因此原报告的根因断言仍是未验证假设，而非已锁定原因。
5. `map.off("sourcedata", onSourceDataFor(map))` 传入的是一个新的闭包，不是注册到 `on` 的同一函数引用，因而无法移除监听器。`sourceReady` 当前避免了重复 finalize，但监听器清理逻辑仍不正确。

### 已验证的修复方向

在 `style.load` 中直接完成 layer inspection、projection 和 UI readiness；不要用 `isSourceLoaded` 或 `idle` 作为初始化前置条件，也不要设置 source-specific 的 6 秒失败定时器。若仍要观察 TileJSON，应在 source 事件的 `sourceDataType === "metadata"` 分支记录诊断信息，而不能将其作为“所有 tile 已完成”的判断。

若在上述最小生命周期下仍出现零 PBF，请建立独立的 MapLibre + Liberty 最小复现并采集 `sourcedata` 的 `sourceDataType`、`TileManager.used/_updated/_sourceLoaded` 和 `error` 事件；届时才能判断是否为 MapLibre/OpenFreeMap/运行环境问题。

## 12. 2026-08-27 缩放后地表瓦片缓慢复现

### 复现

在本地开发页 `/zh/home`（默认 `zoom: 2.25`）连续点击地图的 Zoom in。页面没有 console error，但资源清单显示 12 个 GEBCO WMS `GetMap` 请求和 32 个 OpenFreeMap Natural Earth PNG 请求；本轮没有观察到 OpenFreeMap vector PBF 资源。地球和本地边界/标签最终可显示，故这不是本报告先前讨论的 sourceCache 零派发故障。

### 量化结果（Asia/Singapore 本机）

| 资源 | 单请求实测 | 观察到的数量 | 结论 |
| --- | --- | ---: | --- |
| GEBCO WMS `GetMap`，512×512 PNG | 首字节约 1.26 s；完成约 2.14 s；约 518 KB | 12 | 缩放等待的主要来源；并发下载量约 6 MB。 |
| OpenFreeMap Natural Earth PNG | 首字节约 0.11 s；完成约 0.12 s；约 273 KB | 32 | 明显更快，且可作为地表视觉 fallback。 |

`map-surface-style.ts` 的 `GEBCO_MIN_ZOOM` 是 2.5，但 source 的 `minzoom` 实际设置为 `GEBCO_MIN_ZOOM - 0.5`（2.0），而默认相机已在 2.25。因此 GEBCO 请求在首屏/刚开始缩放时就会发生；代码注释中“2.5 以上才接入”的产品意图与实际请求门槛不一致。

### 后续修复方向（未在本轮实施）

1. 令 GEBCO source 的 `minzoom` 与视觉启用门槛一致，或延后到更高 zoom，确保默认首屏只用已有的 Natural Earth raster。
2. 若仍保留 GEBCO 高倍细节，优先将版本化、可长期缓存的地表瓦片放在受控 CDN/本地资源；公共 WMS 不应成为交互缩放的关键路径。
3. 保留 Natural Earth 作为不阻塞的视觉 fallback，并新增浏览器性能验收：默认首屏与相邻 zoom 不得等待 GEBCO 瓦片才能呈现不透明地表。

### 落地（2026-08-27）

初版将 `GEBCO_MIN_ZOOM` 调整为 4.5，虽消除了默认 WMS 请求，但 Natural Earth 的浅色海面不足以维持地球视觉质量，不能作为可接受方案。

随后视觉复核发现先前 `GEBCO` 在 5.5 后淡出为 0，同时 Liberty `natural_earth` layer 的 `maxzoom: 7` 也会移除唯一的 raster fallback；加上水层 0.16 opacity，导致高 zoom 露出蓝底、低 zoom 呈现浅色/方块感。现已取消 GEBCO 的淡出、将其 source 最大层级设为 6 并允许 overzoom；同时移除 Natural Earth layer 的 `maxzoom`，并将 vector water opacity 设为 1。GEBCO 恢复为默认视角的渐进增强，但以 1024 逻辑 tile size 限制 WMS 请求扇出；其 opacity 固定为 1，避免默认相机恰好落在渐变起点而让已加载的 relief 保持透明。这样公共 WMS 不会阻塞 fallback，任何缩放层级也保留连续的地表和海面。

## 13. 2026-08-27 SVG 覆盖层地平线穿透修复

国界和地名是位于 WebGL globe 之上的 SVG，不受 MapLibre 的 globe stencil 裁剪。此前国界仅按顶点前/后半球切线、地名仅按锚点前半球判断；两者都只被页面矩形裁剪。因此接近地平线的文字可伸出球外，复杂线段也可能在边缘露出。

现通过共享的 `globe-visibility.ts` 按相机中心每帧采样大圆地平线并投影为 SVG `clipPath`。国界与九段线统一放入该裁剪组；地名额外采用 0.08 的前半球安全余量，并要求完整文字包围框均在轮廓中。轮廓无效时两个覆盖层 fail-closed 隐藏。此实现不创建 React 位置 state、不增加网络请求，也不记录位置数据。
