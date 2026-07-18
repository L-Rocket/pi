# Managed Agents 接口规范

| 字段 | 值 |
|---|---|
| 状态 | Draft v1 |
| 日期 | 2026-07-18 |
| 上游文档 | [managed-agents-prd.md](./managed-agents-prd.md)（范围与非目标）、[managed-agents-tech-design.md](./managed-agents-tech-design.md)（模块实现） |
| 读者 | 三个模块的实现者与部署方 |

本文是三个模块（Agent Runtime / Session Service / Sandbox Worker）之间接口的唯一权威定义。与技术方案 §2 的关系：本文取代其协议草图，差异点（`/v1` 前缀、批量 append、bash env/输出修正、grep search hook）以本文为准。

## 1. 模块边界

```
Agent Runtime ──► LLM providers        （直连，不在本规范范围）
Agent Runtime ──► Session Service      （本规范 §4）
Agent Runtime ──► Sandbox Worker       （本规范 §3）
```

- 连接单向：只有 Runtime 主动出站，两个服务永不回连。
- Runtime 内部有两个注入点接口（`SessionStore`、`*Operations`），是本规范 §5 的主题；它们不是网络协议，是 Runtime 进程内的模块边界。
- 任一服务 URL 缺省时，Runtime 回落到对应本地实现（`LocalSessionStore` / 本地 operations），行为与上游一致。

## 2. 公共约定

### 2.1 传输

- HTTP/JSON，请求-响应，无流式、无持久连接。
- 所有路径带 `/v1` 前缀。v1 内只做 additive 演进（新增字段/端点）；破坏性变更升 `/v2`。
- 请求与响应 `Content-Type: application/json`；二进制内容一律 base64 内嵌 JSON（字段文档中标注 `base64`）。
- Session Service 的 entry 流用 NDJSON（`application/x-ndjson`），每行一个序列化后的 `FileEntry`。

### 2.2 认证

- 客户端在存在 token 时发送 `Authorization: Bearer <token>`（Runtime 侧配置项 `PI_MANAGED_TOKEN`）。
- 本仓库两个服务**透传不校验**；校验由部署方前置层（网关/mesh）负责。

### 2.3 错误格式

```ts
type RpcError = { error: { code: string; message: string } };
```

| code | HTTP | 含义 | 客户端行为 |
|---|---|---|---|
| `bad_request` | 400 | 请求体/参数非法 | 上抛 Error(message) |
| `unauthorized` | 401 | 前置层或未来校验失败 | 上抛，不重试 |
| `not_found` | 404 | session / 路径 / opId 不存在 | 上抛 ENOENT 风格 Error |
| `path_escape` | 403 | 路径解析后越出 workspace root | 以 tool error 回模型 |
| `conflict` | 409 | opId 复用 / session id 冲突 | 上抛 |
| `payload_too_large` | 413 | 超过 §2.5 限制 | 上抛 |
| `internal` | 500 | 未分类服务端错误 | 幂等读可重试 1 次 |

非 JSON 错误体（前置层产生）按 HTTP 状态码映射到上表。

### 2.4 超时与重试

| 调用 | 客户端 wall-clock | 重试 |
|---|---|---|
| `/v1/bash/exec` | **不设**（`timeout` 由 worker 端强制执行） | 不重试 |
| `/v1/bash/cancel` | 10s | 不重试 |
| 其余读类（fs/read、stat、readdir、grep、find、session load/list） | 30s | 网络失败或 5xx 重试 1 次 |
| 写类（fs/write、mkdir、session append/rewrite/fork） | 30s | **不重试**（非幂等），失败即上抛 |

取消不依赖"客户端断开连接"（经 L7 代理时连接语义不可靠），只依赖显式 `/v1/bash/cancel`。

**冷启动（沙箱懒加载）**：`PI_SANDBOX_URL` 指向的端点可能是冷的（scale-from-zero，首个工具调用触发召唤）。client 对**连接失败**（connection refused/reset/timeout，请求字节未发出）在 60s 预算内重试，1s 起步指数退避；请求一旦发出即适用上表规则（写不重试）。连接失败重试不违反写幂等约束——请求从未到达服务端。runtime 启动时不做任何沙箱握手/健康检查，无工具调用的会话全程不产生沙箱请求。

### 2.5 大小限制

| 项 | 上限 | 超限行为 |
|---|---|---|
| 请求 body | 64MB | 413 |
| `/v1/fs/read` 单文件 | 64MB（解码后） | `payload_too_large` |
| `/v1/bash/exec` stdout / stderr | 各 32MB | 截断，响应 `stdoutTruncated`/`stderrTruncated: true` |
| `/v1/grep` matches | 请求 `limit`（默认 250） | 截断，`truncated: true` |
| `/v1/find` paths | 请求 `limit`（默认 1000） | 截断，`truncated: true` |

## 3. Sandbox Worker API

进程模型：独立 Node 进程，`--root <dir>` 指定 workspace。worker 进程本身无状态；workspace 文件树是唯一权威数据。

### 3.1 安全语义（所有端点共享）

- **Jail**：所有路径参数（含 bash 的 `cwd`）经 `resolve(root, input)` → `realpath`（存在时）→ 必须等于 root 或以其为前缀，否则 403 `path_escape`。相对路径一律相对 root 解析。
- **Env scrub**：子进程环境 = worker 白名单 `{PATH, HOME, LANG, LC_ALL, TERM, TMPDIR}`（取自 worker 进程 env）**合并**请求级 `env`（请求字段优先）。worker 自身 env 的其余键永不进入子进程。
- **客户端纪律（规范要求，非服务端强制）**：Runtime 的实现**禁止**把自身进程 env 透传进 `env` 字段——provider key 存在于 Runtime env 中，透传即泄露。`env` 只用于扩展显式声明的变量。

### 3.2 端点

#### `POST /v1/bash/exec`

执行命令，完成后一次性返回（无中间输出）。

```ts
// Request
{
  opId: string;            // 客户端生成，取消凭据；同 worker 内同时刻唯一
  command: string;
  cwd: string;             // 过 jail
  timeout?: number;        // 秒；worker 端强制，超时杀进程树
  env?: Record<string, string>;  // 见 3.1，禁止透传 runtime 进程 env
}
// Response
{
  stdout: string;          // base64
  stderr: string;          // base64
  exitCode: number | null; // 被杀（cancel/timeout）时为 null
  timedOut: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}
```

- `opId` 冲突（同 id 仍在运行）→ 409 `conflict`。
- shell 解析与进程树杀法与上游 `utils/shell.ts` 一致（`/bin/bash` → PATH → `sh`；`detached` + kill 进程组）。

#### `POST /v1/bash/cancel`

```ts
// Request
{ opId: string }
// Response
{ cancelled: boolean }     // false = opId 不在运行表（已完成或不存在）
```

收到后 kill 对应进程树；对应 `/v1/bash/exec` 请求以 `exitCode: null` 返回。

#### 文件系统端点

| 端点 | Request | Response |
|---|---|---|
| `POST /v1/fs/read` | `{ path }` | `{ content: string /* base64 */ }` |
| `POST /v1/fs/write` | `{ path, content: string /* base64 */ }` | `{}` |
| `POST /v1/fs/mkdir` | `{ path, recursive?: boolean /* default true */ }` | `{}` |
| `POST /v1/fs/access` | `{ path, mode?: number /* F_OK|R_OK|W_OK 位掩码，默认 F_OK */ }` | `{ ok: boolean }` |
| `POST /v1/fs/stat` | `{ path }` | `{ size, mtimeMs, isFile, isDirectory }` |
| `POST /v1/fs/readdir` | `{ path }` | `{ entries: { name, isDirectory }[] }` |

- 不存在：`fs/read`、`fs/stat`、`fs/readdir` → 404 `not_found`；`fs/access` → `{ ok: false }`（不报错）。
- `fs/write` 父目录不存在 → 404；实现不得隐式建目录（与上游 `writeFile` 行为对齐，建目录走 `fs/mkdir`）。

#### `POST /v1/grep`

```ts
// Request
{
  pattern: string;
  path: string;            // 过 jail；文件或目录
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;        // 前后行数，服务端一并返回，客户端不再逐文件读 context
  limit?: number;          // 默认 250
}
// Response
{
  matches: { path: string; lineNumber: number; line: string;
             before?: string[]; after?: string[] }[];  // context>0 时填充
  truncated: boolean;
}
```

`matches[].path` 为**相对请求 `path` 的相对路径**（搜索单文件时为 `"."`），客户端用请求路径重新锚定到 Runtime 侧绝对路径，从而允许两侧 root 不同。

实现：worker 内 spawn `rg --json`（二进制随 worker 镜像分发），全量收集后按 limit 截断。**注意**：服务端支持返回 context 行；M1 客户端走瘦 hook（`GrepOperations.search`，context 传 0），context 展开由工具经 `GrepOperations.readFile` 完成，与本地 rg 路径共享同一套格式化逻辑，保证输出逐字节一致。

#### `POST /v1/find`

```ts
// Request
{ pattern: string; path: string; limit?: number;    // 默认 1000
  ignore?: string[] }                               // 映射为 fd --exclude（上游工具固定传 ["**/node_modules/**", "**/.git/**"]）
// Response
{ paths: string[]; truncated: boolean }             // 相对请求 path 的相对路径，客户端重新锚定
```

实现：worker 内 spawn `fd --glob`，遵守 `.gitignore`（与上游一致）。

#### `GET /v1/healthz`

`200 { ok: true }`。部署探活用。

## 4. Session Service API

进程模型：独立 Node 进程，`--data-dir <dir>`。存储布局 `<dataDir>/sessions/<sessionId>.jsonl`，文件格式与上游逐字节一致（header 行 + entry 行，见 `session-manager.ts:32-152`）。

### 4.1 一致性语义

- **单写者**：同 session 的写请求（append/rewrite/fork）由服务端 per-session 锁串行化。同 sessionId 被两个 Runtime 同时打开的策略（后到者拒绝/只读）是部署决策，v1 协议不强制（见 §6 演进）。
- **持久化粒度**：由客户端 flush 策略决定（§5.1）。服务端只保证：已返回成功的 append 持久；rewrite 原子（临时文件 + rename）。
- **崩溃恢复**：Runtime 崩溃后，新实例凭 sessionId 全量 load 恢复。

### 4.2 端点

#### `POST /v1/sessions`

```ts
// Request
{ id?: string;             // 缺省服务端生成 uuidv7
  cwd: string;
  parentSession?: string }
// Response
{ sessionId: string }
```

写 header 行创建文件。id 冲突 → 409 `conflict`。

#### `GET /v1/sessions/:id/entries`

全量加载。响应 `application/x-ndjson`，文件内容原样流出（首行 header + 后续 entry 行）。不存在 → 404。

#### `POST /v1/sessions/:id/entries`

追加，**支持批量**（turn 边界 flush 一次请求）：

```ts
// Request
{ entries: string[] }      // 每行一个序列化 SessionEntry（不含 \n），按数组顺序追加
// Response
{ appended: number }
```

per-session 写锁内逐行 append。session 不存在 → 404。

#### `PUT /v1/sessions/:id/entries`

```ts
// Request
{ entries: string[] }      // 全量，含 header 行
// Response
{ rewritten: number }
```

写锁内写临时文件 + rename，原子替换。用于 migration / compaction / fork 目标写入。

#### `GET /v1/sessions?cwd=<path>`

```ts
// Response
{ sessions: {
    id: string;
    cwd: string;
    name?: string;              // session_info entry
    parentSession?: string;
    created: string;            // ISO 8601
    modified: string;
    messageCount: number;
    firstMessage: string;
  }[] }
```

`cwd` 参数精确匹配 header 的 cwd 字段；缺省返回全部。按 modified 降序。

#### `POST /v1/sessions/:id/fork`

```ts
// Response
{ sessionId: string }          // 新 session
```

写锁内复制文件、生成新 id、改写 header（`id` / `timestamp` / `parentSession` = 源 id）。

#### `GET /v1/healthz`

`200 { ok: true }`。

## 5. Runtime 侧接口（进程内模块边界）

### 5.1 `SessionStore`

```ts
interface SessionStore {
  load(sessionRef: string): Promise<string[]>;               // NDJSON 行（含 header）
  append(sessionRef: string, line: string): Promise<void>;   // 进写队列，不保证已发出
  rewrite(sessionRef: string, lines: string[]): Promise<void>; // 排队执行，await 可见结果
  flush(sessionRef: string): Promise<void>;                  // 排空队列：pending 全部发出并确认
  list(cwd?: string): Promise<SessionInfo[]>;
  fork(sourceRef: string): Promise<string>;                  // 返回新 ref
}
```

- `sessionRef`：本地为文件路径；远程为 `managed://sessions/<id>`（opaque，消费方不解析）。
- **写队列契约**：单 ref 内全部写操作串在一条 Promise 链上保序；`append` 只进内存队列；`flush` 返回的 Promise 在队列排空（含本次 flush 前所有 append）后 resolve。
- **flush 时机**（`RemoteSessionStore` 默认策略）：assistant `message_end` 后 + **进程退出前必须 await 一次 `flush`（shutdown drain）**。崩溃丢失粒度 = 最后一个未 flush 的 turn。需要更接近本地逐 entry 持久化的部署，可在 `RemoteSessionStore` 配置 `flushOnAppend: true`（每 entry 一次批量 append 请求），协议不变。
- `LocalSessionStore`：抽取现有 fs 逻辑，`flush` 为 no-op，行为与上游逐字节一致（含 deferred-first-write）。

### 5.2 远程 `*Operations` 映射

7 个工具经 `ToolsOptions`（`tools/index.ts:86-94`）注入。映射：

| 接口成员 | 实现 |
|---|---|
| `BashOperations.exec` | 生成 opId → `/v1/bash/exec`；`signal` abort → `/v1/bash/cancel` 并抛 `Error("aborted")`；`timedOut` → 抛 `Error("timeout:<n>")`；响应后一次性 `onData(stdout)`/`onData(stderr)` |
| `ReadOperations.readFile` / `access` | `/v1/fs/read`（base64→Buffer）/ `/v1/fs/access` |
| `ReadOperations.detectImageMimeType` | 保持本地（magic bytes 在已读 Buffer 上做） |
| `WriteOperations.writeFile` / `mkdir` | `/v1/fs/write` / `/v1/fs/mkdir` |
| `EditOperations.readFile` / `writeFile` / `access` | `/v1/fs/read` / `/v1/fs/write` / `/v1/fs/access` |
| `GrepOperations.search`（**新增 hook**） | `/v1/grep` |
| `GrepOperations.isDirectory` / `readFile` | `/v1/fs/stat` / `/v1/fs/read`（仅兜底路径用） |
| `FindOperations.glob` / `exists` | `/v1/find` / `/v1/fs/access` |
| `LsOperations.exists` / `stat` / `readdir` | `/v1/fs/access` / `/v1/fs/stat` / `/v1/fs/readdir` |

**对上游的两处 additive 依赖**（本规范要求，技术方案 §4 接线点清单需同步更新）：

1. **grep search hook**：现状 grep 主路径在工具体内 `spawn(rg)`（`grep.ts:221`），`GrepOperations` 只覆盖 `isDirectory`/`readFile`，注入无法接管搜索。需仿照 find 的 `customOps?.glob` 分支（`find.ts:155`）给 `GrepOperations` 增加可选 `search` 成员：提供时走该实现并跳过本地 rg spawn。这是对上游工具文件的 additive 修改，默认行为不变。
2. **bash 溢出输出回写**：现状截断判定与溢出落盘都在工具体内的 `OutputAccumulator`（写到 runtime 本地 tmpdir，`output-accumulator.ts:215`），远程模式下该路径对模型不可见（read 走沙箱）。需上游 additive：`BashOperations` 增加可选溢出持久化 hook（提供时工具以其返回值作为 `fullOutputPath`，替代本地 tmpdir 落盘）；远程实现经 `/v1/fs/write` 写到沙箱内约定路径（`<root>/.pi/tmp/bash-<opId>.log`）。

### 5.3 配置

| 环境变量 | 含义 | 缺省行为 |
|---|---|---|
| `PI_SESSION_URL` | Session Service base URL | 缺省 → `LocalSessionStore` |
| `PI_SANDBOX_URL` | Sandbox Worker base URL | 缺省 → 本地 operations；存在即远程模式，端点可为冷（懒召唤），启动无握手 |
| `PI_MANAGED_TOKEN` | `Authorization: Bearer` 透传 | 缺省不发送 |

集中由 `packages/managed/src/config.ts` 的 `resolveManagedConfig()` 读取，coding-agent 不散落读 env。

## 6. 演进约定

- v1 内允许：新增端点、新增可选请求字段、新增响应字段。客户端必须忽略未知响应字段；服务端必须忽略未知请求字段。
- 预留演进点（v1 不实现，协议已留位）：
  - **写者 fencing**：append/rewrite 请求可加 `writerId` + `epoch` 字段，实现"同 session 后到者拒绝/只读"策略。
  - **大文件分块**：`fs/read`/`fs/write` 的 `offset`/`length` 分块或 raw body 通道。
  - **流式 bash**：如需中间输出/stdin 交互，新增 WebSocket 端点，`/v1/bash/exec` 语义不变。
  - **存储后端替换**：Session Service 内部可换对象存储/DB，端点与语义不变。
