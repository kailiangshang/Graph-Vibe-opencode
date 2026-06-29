# Graph Vibe — Web 可视化参考

> 来源：graph-vibe-coding `internal/web/server.go` + `internal/web/static/{index.html,app.js}`（~1870 行原生 JS）+ `archive/loops/loop-5/design-supplement.md`（吉祥物规格）。
> **以代码为准**。这是可视化子项目（子项目 6）的参考。移植到 opencode 的 web（`packages/app`/`packages/web`，SolidJS）时借鉴协议与渲染规格，重写前端。

## 1. HTTP API（`server.go`）

| 方法 | 路由 | 语义 |
|---|---|---|
| GET | `/api/nodes` `/api/edges` `/api/graph` | 列节点/边/两者（graph 带 count） |
| GET | `/api/session/current` | 当前活跃 session |
| GET | `/api/current-plan` | 当前 session 的节点+边+状态计数 |
| GET/POST | `/api/nodes/<id>/{messages,generation-runs,tool-runs,generation-readiness}` | 节点历史/就绪度（blocker、locked） |
| POST | `/api/nodes/<id>/lifecycle` | body `{status,test_status,note}`；`verified` 需 implemented+test passed；记 ToolRun + 广播 |
| POST | `/api/nodes/<id>/generate?dry_run=true` | 入队 **durable GenerationJob**（HTTP 202）；未就绪 409 |
| GET/POST | `/api/summaries/{session,node/<id>}` + `/refresh` | 图摘要读取/重建+广播 |
| GET | `/api/generation-jobs/<id>` · POST `/cancel` | 作业状态/取消 |

## 2. WebSocket 协议（`gorilla/websocket`）

`Message{Type, Payload}`。连上即收 `{type:"init",payload:{nodes,edges}}`。客户端可发 `ping`(→pong)/`get_nodes`(→`{type:"nodes"}`)。

**服务端→客户端消息（⚠️ 标"实际发"vs"仅客户端 handler"）**：

| type | 实际由服务端发？ | 触发 |
|---|---|---|
| `init` / `nodes` / `pong` / `error` | ✅ | 连接 / get_nodes / ping |
| `node_update` / `edge_update` | ✅ | CLI plan/generate/merge + lifecycle |
| `plan_updated` | ✅ | plan → 触发前端 `loadCurrentPlan` |
| `summary_update` | ✅ | 摘要刷新 |
| `generation_job_update` | ✅ | 作业生命周期（含实时 stdout/stderr） |
| `node_action` | ✅ | lifecycle/generate |
| `merge_completed` / `sync_report` | ✅（但前端仅作元数据） | merge / sync |
| `highlight_path` | ❌ **仅客户端 handler，服务端从不发** | （要我们接 `/graph path` 广播） |
| `mascot_action` | ❌ **仅客户端 handler，服务端从不发** | （要我们接 §4 触发） |

广播： buffered channel(100)，RLock 遍历客户端写，出错踢出。客户端断开每 3s 重连。

## 3. Canvas 渲染（`app.js`，可直接搬的数）

**力导向布局**（类 Fruchterman-Reingold，O(n²)/帧）参数：
`repulsion=5000 · attraction=0.005 · damping=0.9 · minDistance=80 · centerForce=0.01`；斥力仅 300px 内；弹簧力 `(dist-minDistance)*attraction`；中心引力 `-pos*centerForce`；`v=(v+f)*damping`。
- **大图阈值 1000**：超过改**方格布局**（间距 86，cluster 概览 260）+ **分层渲染预算**（节点 1200/边 1500）+ 空闲时降到 100ms/帧 + 交互时 200ms 全速。
- **标签**：`zoom≥0.55 || rendered≤350` 才画；大图 + zoom<0.55 不画边。

**相机/交互**：变换 `translate(w/2+cam.x, h/2+cam.y); scale(zoom)`；zoom 区间 `[0.1,5]`；**滚轮缩放到光标**；`Space+拖动`或空白拖动平移；节点拖拽按 zoom 缩放世界坐标。
**视口裁剪**：节点 +50px、边 +120px margin。
**命中**：世界坐标欧氏距离 `< 30*scale`。
**配色**：节点按 type（prd `#ff6b9d`、composite `#2196f3`、atomic `#4caf50`）；状态点（pending `#ffc107`/implemented `#4caf50`/verified `#2196f3`/deprecated `#757575`）；选中/路径节点 `shadowBlur 15–25`。边按 relation 着色（contains 蓝/blocks 红/addresses 绿/uses 浅灰/deprecated_by 灰），箭头（dist<60 跳过）。**高亮路径**：`#ffeb3b`、lineWidth 3–4、`shadowBlur 10–15`、虚线 `[10,5]`。

## 4. 吉祥物动画系统（`app.js`，⚠️ 服务端触发缺失）

**规格**（`design-supplement.md`）：8 个情境动作 + 基础 idle/wave。客户端引擎完整（纯 Canvas），**但服务端从不发 `mascot_action`**——目前只有 DOMContentLoaded 一个 demo 触发。移植时**要把服务端触发接上**。

- 队列：`mascotQueue`，**maxQueueSize=10**（溢出丢最旧）；**最多 3 个吉祥体同框**；每帧 `processMascotQueue` 给空闲吉祥体派一个动作；吉祥体画在**世界坐标**（随相机变换），cluster 概览下隐藏。
- 吉祥体在目标节点附近动作，目标位置由 `nodePositions` 解析。

| 动作 | 时长 | 视觉 | 设计触发（要接） |
|---|---|---|---|
| `idle` | 3000ms | sin 浮动 ±3px、微笑 | 基础 |
| `wave` | 2000ms | 挥手 | 基础 |
| `waiting` | 4000ms | 慢浮、每 30 帧滴汗 | 等用户输入 |
| `sweating` | 3000ms | 快浮、向上汗滴每 20 帧 | 代码生成中 |
| `thinking` | 3500ms | 灯泡 glow + 黄 shadowBlur | 深度思考 |
| `search` | 2500ms | 旋转放大镜 | 搜索图 |
| `connect` | 2000ms | 到邻居的绿色虚线短桩 | 创建边 |
| `fail` | 2500ms | 身体 rotate、皱眉 | 测试失败 |
| `success` | 3000ms | `|sin|*20` 跳跃、大笑 | 测试通过 |
| `chopping` | 2500ms | `|sin|*8` 浮、画斧头 | 删除 deprecated 节点 |

汗滴粒子：`{x,y,vy}` 重力积分，过脚淘汰，`#87CEEB`。

> 移植：吉祥体类（纯 Canvas）可直接移植/重写；**关键缺口**是服务端在各生命周期事件发 `mascot_action`（generate-start→sweating、diagnostics pass→success / fail→fail、deprecate→chopping、create edge→connect、`/graph path`→search）。`highlight_path` 同理要服务端发。

## 5. Durable Web 生成作业（值得借鉴的模式）
`generation_jobs`：per-node 单跑（`runningNode`）、30min 超时、**重启恢复**（queued+cancel-requested→cancelled；running→failed）、context 传播取消、实时 stdout/stderr 经 `generation_job_update` 流式广播。HTTP 202 入队 + `/cancel` + `GET status`。

## 6. 移植到 opencode 的注意
- opencode 的 web 是 SolidJS（`packages/app`/`packages/web`），有自己的 server/HttpApi。**协议借鉴**（消息类型、init/增量更新/广播），前端用 Solid 重写（不搬原生 JS）。
- **力导向参数 + 相机/裁剪/配色 + 大图策略**这些数直接采用（实测过的）。
- 吉祥体：重写为 Solid 组件，**补上服务端触发**（这是旧代码的缺口，也是可视化子项目的价值点）。
- durable job 模式借鉴 opencode 的 session 持久化风格。
- ⚠️ 旧代码的 TUI（Bubble Tea）**不搬**——我们用 opencode 的 TUI（opentui/Solid）。
