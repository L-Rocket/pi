# Managed Agents 分离架构 PRD

| 字段 | 值 |
|---|---|
| 状态 | Draft v2（评审中） |
| 日期 | 2026-07-18 |
| 仓库 | L-Rocket/pi（fork of earendil-works/pi） |
| 范围包 | 新增 `packages/managed`；最小侵入 `packages/coding-agent` |

## 1. 背景

pi coding agent 目前是单体进程：session 状态持久化与工具执行耦合在 agent 进程内：

- **Session 耦合**：`SessionManager`（`packages/coding-agent/src/core/session-manager.ts:791`）用同步 `fs` 调用读写本地 `~/.pi/agent/sessions/` 下的 JSONL 文件，本地磁盘是唯一权威存储，执行节点崩溃即丢失运行现场。
- **执行耦合**：7 个内置工具（read/bash/edit/write/grep/find/ls）全部在 agent 进程内通过 `fs` / `child_process` 直接操作本机，与 agent 同权，无安全边界。

目标形态是云上 managed agents：agent 拆成 **Agent Runtime / Session Service / Sandbox Worker** 三个独立部署、可组合的部分。

推理不设独立服务：provider API 本身就是远程集中服务，中间加代理只会多一跳、多一个故障点。provider key 由部署层注入 Agent Runtime 环境（如 K8s Secret → env），runtime 直连 provider（上游默认行为，零代码改动）；真正的安全边界是沙箱——key 永不进入执行环境。

## 2. 目标与非目标

### 2.1 目标

1. **Session 分离**：Session Service 是 session 状态的唯一权威存储，Agent Runtime 可随时重建（远程权威）。
2. **执行分离**：工具执行全部发生在 Sandbox Worker 内，Agent Runtime 不直接触碰执行环境的文件系统和进程空间。
3. **Runtime 无状态化**：Agent Runtime 是 session 的计算投影——由 sessionId 召唤、凭 sessionId 恢复、空闲可回收。
4. **可组合**：三个部分各自独立启动、独立容器化；Runtime 仅通过 URL 引用两个服务，任一可替换为本地实现（开发态）或远程实现（云态）。

### 2.2 非目标（本仓库明确不做）

- **不做编排**：多 agent 协作、任务分发、工作流编排。
- **不做资源调度**：worker 池管理、自动伸缩、负载均衡、runtime 的 summon/recycle 触发——由外部基础设施（如 Kubernetes）负责；本仓库只保证 runtime **可召唤**。
- **不做推理网关**：provider key 部署注入即可，不设独立推理服务。
- **不做凭证服务**：多类型凭证（git token、registry 等）的管理留到后续阶段，届时作为共享基础设施（接口 + 外部实现如 Vault / K8s Secrets），不进任何组件内部模型。
- **不做多租户控制面**：租户管理、配额、计费、鉴权体系（协议预留 auth token 位置，校验逻辑留给部署方前置层）。
- **不改动上游核心语义**：agent loop、工具定义、session 文件格式保持与上游一致，便于跟踪 upstream。

## 3. 术语

| 术语 | 含义 |
|---|---|
| Agent Runtime | 运行 agent loop 的进程（pi coding-agent core），无状态、sessionId 寻址 |
| Session Service | session 权威存储服务，提供 load/append/rewrite/list/fork |
| Sandbox Worker | 工具执行环境，接收 RPC 操作请求并在受控环境内执行 |
| workspace | 沙箱内 agent 工作的目录树（worker 的 `--root`），系统两块权威状态之一 |
| `*Operations` | 各工具的可插拔执行接口（`BashOperations`、`ReadOperations` 等） |
| `SessionStore` | 本 PRD 新增的 session 存储抽象（异步） |

## 4. 总体架构

```
                 ┌────────────────────────────┐
                 │       Agent Runtime        │
                 │  (pi coding-agent core)    │
                 │  无状态 · sessionId 寻址    │
                 │  provider key 部署注入内存  │
                 └──────────────┬─────────────┘
                                │ 仅两个出站连接，全部走 URL 配置
              ┌─────────────────┼──────────────────┐
              ▼                 ▼                  ▼
   ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
   │ LLM providers  │  │ Session Service│  │ Sandbox Worker │
   │ (直连, 无网关)  │  │ (权威存储)      │  │ (工具执行环境)  │
   │                │  │                │  │                │
   │ Anthropic /    │  │ load / append /│  │ bash/read/write│
   │ OpenAI / ...   │  │ rewrite / list │  │ /edit/grep/    │
   │                │  │ / fork         │  │ find/ls        │
   └────────────────┘  └───────┬────────┘  └───────┬────────┘
                               ▼                   ▼
                        持久卷 / 对象存储      workspace 持久卷
                        (JSONL 格式不变)      (代码与产物)
```

系统里仅有两块权威状态：**session**（对话历史，append 为主的 journal）与 **workspace**（代码状态，随机读写的文件树）。其他一切（runtime、worker 进程）都可重建。

组合方式：Agent Runtime 启动时接收两个 URL（环境变量或 CLI flag）：

```bash
PI_SESSION_URL=http://session:8081 \
PI_SANDBOX_URL=http://sandbox:8082 \
pi -p "fix the bug in src/"
```

任一 URL 缺省时回落到当前本地行为（本地 session 文件 / 本地工具执行），保证开发态体验与上游一致。

**Runtime 的生命周期（wake 模型）**：prompt 到达 → 外部控制面按 sessionId 查活跃 runtime → 没有则唤醒一个 → runtime 从 Session Service 加载 session → 执行 → 空闲超时由外部回收。runtime 的 identity 就是 sessionId；summon/recycle 的触发逻辑在外部控制面，不在本仓库。

## 5. 组件设计

### 5.1 Agent Runtime

**职责**：运行 agent loop 的唯一核心。三分离后它本身无状态、可召唤。

- **无状态**：不持有 session 数据（全在 Session Service），不持有 workspace（全在 Sandbox），崩溃后由新实例凭 sessionId 恢复。
- **凭证边界**：provider key 由部署层注入 env，仅存于 runtime 内存；runtime 是可信代码（我们的代码），持 key 与任何后端服务持 DB 密码同级；key 永不进入 Sandbox（见 5.3 env scrub）。
- **推理**：直连 provider，使用上游默认 `streamSimple` 路径，零代码改动。
- **恢复语义**：崩溃恢复粒度 = 上一个完整 turn（与上游本地行为等价，见 5.2 一致性）。

### 5.2 Session Service

**职责**：session 状态的唯一权威存储。执行节点崩溃后，新 runtime 凭 `sessionId` 恢复全部历史。

**数据模型**：沿用现有 JSONL 格式与 `SessionEntry` 类型（v3，`session-manager.ts:32-152`），存储后端首版为服务端 JSONL 文件（每 session 一个文件），后续可换对象存储而协议不变。

**API**（HTTP/JSON，NDJSON 用于 entry 流）：

| 方法 | 路径 | 语义 |
|---|---|---|
| `POST` | `/sessions` | 创建 session（header：id/cwd/parentSession），返回 sessionId |
| `GET` | `/sessions/:id/entries` | 全量加载 entry 流（NDJSON） |
| `POST` | `/sessions/:id/entries` | 追加一条 entry（服务端保证同 session 内顺序） |
| `PUT` | `/sessions/:id/entries` | 全量重写（migration/fork 用，低频） |
| `GET` | `/sessions?cwd=` | 列出 session（支持按 cwd 过滤） |
| `POST` | `/sessions/:id/fork` | 复制生成新 session，返回新 sessionId |

**一致性语义**：远程权威 + turn 边界 flush。

- runtime 侧每次 append 先入本地写队列，**在 assistant `message_end`（turn 结束）时 flush**；崩溃恢复粒度 = 上一个完整 turn，与上游本地行为等价（本地 JSONL 也是 turn 结束后才落盘 assistant 消息）。
- `rewrite`/`fork` 为同步等待（低频操作）。
- 单 session 同一时刻只允许一个 writer（服务端用 per-session 锁串行化 append）。

**Runtime 侧接线（本 PRD 最大改动）**：新增异步 `SessionStore` 接口，注入 `SessionManager`：

```ts
interface SessionStore {
  load(sessionRef: string): Promise<string[]>;              // JSONL lines
  append(sessionRef: string, line: string): Promise<void>; // 写队列
  rewrite(sessionRef: string, lines: string[]): Promise<void>;
  flush(sessionRef: string): Promise<void>;
  list(cwd?: string): Promise<SessionInfo[]>;
  fork(sourceRef: string): Promise<string>;                 // 返回新 ref
}
```

- `LocalSessionStore`：抽取 `SessionManager` 现有 fs 逻辑，行为与上游完全一致（默认）。
- `RemoteSessionStore`：HTTP 客户端，append 走内存队列 + turn 边界 flush。
- `SessionManager` 改造原则：**外部同步 API 不变**。内存索引（`byId`/`leafId`/`fileEntries`）本来就是权威，磁盘只在 load（构造前异步预取）和 persist（写队列）两个点接触 store。新增异步工厂（如 `SessionManager.openWithStore`），现有同步工厂保留并委托 `LocalSessionStore`。
- `sessionFile` 字段语义扩展为 opaque ref（远程时为 `managed://sessions/<id>`）；orchestrator 已将其视为不透明字符串，无影响。

### 5.3 Sandbox Worker

**职责**：在受控环境内执行全部工具操作。Agent Runtime 不再直接 `fs`/`child_process`。

**通信协议：RPC 调用，无流式**。

- 每次工具调用 = 一次 HTTP POST（JSON 请求 → JSON 响应），操作完成才返回。
- 单向发起：只有 runtime → worker 的连接，worker 永不回连；无持久连接状态，worker 重启不影响协议。
- 并行工具调用 = 并发 HTTP 请求，天然支持。
- 文件内容首版 base64 编码走 JSON。
- **无流式 = 无中间输出**：bash 执行期间不产生 `onUpdate` 部分结果，结果在完成时一次性返回（首版接受的 UX 取舍）。

| 操作 | 路径 | 请求 → 响应 | 对应接口 |
|---|---|---|---|
| 执行命令 | `POST /bash/exec` | `{opId, command, cwd, timeout} → {stdout, stderr, exitCode, timedOut}` | `BashOperations.exec` |
| 取消命令 | `POST /bash/cancel` | `{opId} → {cancelled}` | AbortSignal 映射 |
| 读文件 | `POST /fs/read` | `{path} → {content(base64)}` | `ReadOperations` / `EditOperations.readFile` |
| 写文件 | `POST /fs/write` | `{path, content(base64)} → {}` | `WriteOperations` / `EditOperations.writeFile` |
| 建目录 | `POST /fs/mkdir` | `{path} → {}` | `WriteOperations.mkdir` |
| 存在性/权限 | `POST /fs/access` | `{path, mode} → {ok}` | `*Operations.access` / `exists` |
| stat | `POST /fs/stat` | `{path} → {size, mtime, isDirectory, ...}` | `LsOperations.stat` |
| 列目录 | `POST /fs/readdir` | `{path} → {entries[]}` | `LsOperations.readdir` |
| grep | `POST /grep` | `{pattern, path, glob, ...} → {matches[]}` | `GrepOperations` |
| find | `POST /find` | `{pattern, path, limit} → {paths[]}` | `FindOperations` |

**取消语义**：client 生成 `opId` 并随 exec 请求发送；agent loop 的 AbortSignal（用户中断）触发 `POST /bash/cancel`，worker 收到后 kill 对应进程树。**不依赖"客户端断开连接"隐式取消**（经过 L7 代理时连接语义不可靠）。bash 的 `timeout` 由 worker 端强制执行，client 不设 wall-clock 超时。

**Worker 实现**：独立 Node 进程，启动参数 `--root <dir>`：

- **cwd jail**：所有路径解析后必须落在 `--root` 内，逃逸请求直接拒绝（`path.resolve` + 前缀校验 + realpath 防符号链接逃逸）。
- **env scrub**：子进程环境白名单（`PATH`/`HOME`/`LANG` 等最小集），不继承 worker 进程 env——provider key 等一切秘密都不可能出现在执行环境里。
- bash/grep/find 在 worker 进程内 spawn（rg/fd 二进制随 worker 镜像分发）。
- **状态划分**：worker 进程无状态（纯执行 API，杀掉重启不影响）；workspace（`--root` 文件树）有状态，是权威数据。云上模型 = worker 是可替换容器，workspace 是挂进去的持久卷。
- 本仓库只交付到"独立进程 + 受限环境"这一档；容器/VM/远程机隔离由部署方提供——**协议不变**，worker 镜像即可作为容器 entrypoint。

**Runtime 侧接线**：7 个工具全部已有 `*Operations` 注入点（`packages/coding-agent/src/core/tools/index.ts:86-94` 的 `ToolsOptions`）。新增远程实现 `RemoteBashOperations`、`RemoteReadOperations` 等（内部共用一个 sandbox RPC client），当 `PI_SANDBOX_URL` 存在时经 `ToolsOptions` 注入。工具定义、agent loop、审批 hook 全部零改动。

## 6. 对现有代码的改动清单

原则：**additive 优先**，上游文件改动最小化，保证 fork 可持续 rebase upstream。

| 改动 | 位置 | 性质 |
|---|---|---|
| 新增 `packages/managed`：共享协议类型、两个服务、两个客户端、`managed` CLI | 新包 | 纯新增 |
| `SessionStore` 接口 + `LocalSessionStore`（抽取现有 fs 逻辑）+ 异步工厂 | `coding-agent/src/core/session-manager.ts` | 重构，外部 API 不变 |
| `PI_SANDBOX_URL` 存在时注入远程 `*Operations` | `coding-agent` 工具装配处 | additive 分支 |
| turn 边界调用 `store.flush()` | `coding-agent/src/core/agent-session.ts`（`message_end` 处理处） | additive 调用 |

不改动：agent loop、工具定义、session 文件格式、RPC 模式协议、orchestrator、推理路径。

## 7. 里程碑

每个里程碑结束系统均可运行。

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 执行分离 | `packages/managed` 骨架 + 协议类型 + Sandbox Worker + 7 个远程 `*Operations` + `PI_SANDBOX_URL` 接线 | agent 在 worker 的 `--root` 内完成读写文件 + 跑 bash，逃逸路径被拒绝 |
| M2 Session 分离 | `SessionStore` 抽象 + `LocalSessionStore` + Session Service + `RemoteSessionStore` + `PI_SESSION_URL` 接线 | 杀掉 runtime 进程，新进程凭 sessionId 恢复全部历史继续对话 |
| M3 组合 demo | `managed` CLI（分别启动两服务 + runtime）+ 集成测试 + 使用文档 | 两服务独立启动，runtime 仅通过 URL 组合，完成一个真实 coding 任务 |

测试策略：沿用仓库现有 harness（`packages/coding-agent/test/suite/harness.ts` + faux provider），不产生真实 API 调用；sandbox/session 服务测试用临时目录。

## 8. 验收标准（GWT）

**AC1 凭证边界**
- Given provider key 仅通过部署注入 Agent Runtime 环境
- When agent 完成一次包含 bash 工具调用的任务
- Then 推理正常走 runtime 直连 provider
- And 沙箱内执行 `env` 及读取环境文件均无法获取任何 provider key

**AC2 执行分离**
- Given Sandbox Worker 以 `--root /tmp/work` 运行
- When agent 执行 `bash`/`write`/`edit` 等工具
- Then 所有副作用发生在 `/tmp/work` 内
- And 任何解析后越出 root 的路径（含符号链接逃逸）被拒绝并返回错误
- And 执行中的 bash 可通过 cancel 被终止（进程树被杀）

**AC3 Session 分离（远程权威）**
- Given runtime 正在使用 Session Service 进行对话
- When 在 turn 结束后杀掉 runtime 进程
- And 用同一 sessionId 在新节点启动 runtime
- Then 新 runtime 恢复全部历史并可继续对话
- And 崩溃点最多丢失最后一个未完成 turn

**AC4 可组合**
- Given 两个服务各自独立启动（可分别在不同容器/机器）
- When runtime 仅通过两个 URL 启动
- Then 完成一个包含"读代码 → 改文件 → 跑命令验证"的完整 coding 任务
- And 任一 URL 缺省时 runtime 回落到对应本地实现，行为与上游一致

## 9. 开放问题

1. **服务间鉴权**：两个 URL 前的 token 校验由谁做（本仓库只留 `Authorization` 透传，校验放部署方前置层？）
2. **session 并发写**：同一 sessionId 被两个 runtime 同时打开时的策略（首版：服务端 per-session 锁，后到者拒绝或只读？）
3. **大文件传输**：`fs/read`/`fs/write` 的 body 大小上限与分块策略（首版 base64 有 ~33% 膨胀）。
4. **交互式 bash**：无流式 RPC 不支持 stdin 交互与中间输出；如未来需要，再评估流式/WebSocket，操作语义不变。
5. **workspace 分布式实现**：云上首版方向为 PV-per-workspace（单写者假设匹配 RWO 卷语义），快照同步模型留待弹性需求驱动。
6. **凭证服务**：多类型凭证（git/registry/storage）需求出现后，作为共享基础设施单独立项（接口 + 外部实现）。

## 附录：关键代码事实索引

| 事实 | 位置 |
|---|---|
| SessionManager（同步 fs，唯一消费入口） | `packages/coding-agent/src/core/session-manager.ts:791` |
| session JSONL 格式与 entry 类型（v3） | `packages/coding-agent/src/core/session-manager.ts:32-152` |
| 工具 `*Operations` 注入点汇总 | `packages/coding-agent/src/core/tools/index.ts:86-94` |
| `BashOperations`（注释明示可远程委托） | `packages/coding-agent/src/core/tools/bash.ts:56-74` |
| 工具审批 hook（沙箱之上的另一道闸） | `packages/agent/src/agent-loop.ts:621-644` |
