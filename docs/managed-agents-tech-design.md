# Managed Agents 技术方案

| 字段 | 值 |
|---|---|
| 状态 | Draft v1 |
| 日期 | 2026-07-18 |
| 上游文档 | [managed-agents-prd.md](./managed-agents-prd.md)（范围与非目标以 PRD 为准） |
| 范围包 | 新增 `packages/managed`；最小侵入 `packages/coding-agent` |

本文是 PRD 的实现层设计：模块划分、接口定义、接线点、数据流、错误约定、测试与任务分解。

## 1. 总体设计

### 1.1 包结构

```
packages/managed/
├── package.json               # @earendil-works/pi-managed（无新增运行时依赖，仅用 node 内置 + workspace 包）
├── src/
│   ├── protocol/
│   │   ├── sandbox.ts         # 沙箱 RPC 请求/响应类型 + 编解码
│   │   ├── session.ts         # session 服务请求/响应类型
│   │   └── errors.ts          # 统一错误格式与错误码
│   ├── sandbox/
│   │   ├── server.ts          # Sandbox Worker HTTP 服务（node:http）
│   │   ├── jail.ts            # 路径 jail（resolve + realpath + 前缀校验）
│   │   ├── env.ts             # 子进程环境白名单
│   │   ├── exec.ts            # bash 执行与 opId 进程注册表
│   │   └── search.ts          # grep/find（spawn rg/fd，收集输出）
│   ├── session-service/
│   │   ├── server.ts          # Session Service HTTP 服务
│   │   └── store.ts           # JSONL 文件存储 + per-session 写锁
│   ├── client/
│   │   ├── sandbox-client.ts  # SandboxClient（fetch 封装）
│   │   ├── operations.ts      # 7 个远程 *Operations 实现
│   │   └── session-store.ts   # RemoteSessionStore（写队列 + flush）
│   ├── config.ts              # resolveManagedConfig()：读 PI_SESSION_URL / PI_SANDBOX_URL
│   └── cli.ts                 # managed sandbox|session|run
└── test/                      # 单元 + 集成测试
```

依赖方向：`protocol` 无依赖；`sandbox` / `session-service` 依赖 `protocol`；`client` 依赖 `protocol` + `@earendil-works/pi-coding-agent`（实现其 `*Operations` / 对接 `SessionStore`）。coding-agent **不依赖** managed——接线通过 env 配置 + 可选注入完成（见 §4）。

### 1.2 关键决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 传输 | HTTP/JSON 请求-响应（node:http + 全局 fetch） | 无流式需求；零新增依赖；与仓库风格一致 |
| 流式 | 不支持 | PRD 已定；bash 结果完成时一次性返回 |
| 取消 | 显式 `opId` + `/bash/cancel` | 经 L7 代理时连接断开语义不可靠 |
| 二进制 | base64 内嵌 JSON | 首版简单；开放问题留分块/raw body |
| session 写 | 内存队列 + turn 边界 flush | 保持 SessionManager 外部同步 API 不变 |
| 上游改动 | additive 优先 | fork 可持续 rebase upstream |

## 2. 协议设计

### 2.1 公共约定

- 所有端点 `Content-Type: application/json`；错误统一：

```ts
type RpcError = { error: { code: string; message: string } };
// code ∈ "bad_request" | "not_found" | "path_escape" | "conflict" | "internal"
```

- 认证：`Authorization: Bearer <token>` 透传，校验由部署方前置层负责（本仓库不实现）。
- 所有路径参数为**相对于 workspace root 的相对路径**或绝对路径；服务端一律过 jail。

### 2.2 沙箱 RPC（protocol/sandbox.ts）

```ts
// bash
interface BashExecRequest  { opId: string; command: string; cwd: string; timeout?: number; }
interface BashExecResponse { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; }
interface BashCancelRequest { opId: string; }
interface BashCancelResponse { cancelled: boolean; }

// fs
interface FsReadRequest    { path: string; }
interface FsReadResponse   { content: string; }              // base64
interface FsWriteRequest   { path: string; content: string; } // base64
interface FsMkdirRequest   { path: string; recursive?: boolean; }
interface FsAccessRequest  { path: string; mode?: number; }
interface FsAccessResponse { ok: boolean; }
interface FsStatRequest    { path: string; }
interface FsStatResponse   { size: number; mtimeMs: number; isFile: boolean; isDirectory: boolean; }
interface FsReaddirRequest { path: string; }
interface FsReaddirResponse { entries: { name: string; isDirectory: boolean }[]; }

// search
interface GrepRequest  { pattern: string; path: string; glob?: string; ignoreCase?: boolean;
                         literal?: boolean; context?: number; limit?: number; }
interface GrepMatch    { path: string; lineNumber: number; line: string; }
interface GrepResponse { matches: GrepMatch[]; truncated: boolean; }
interface FindRequest  { pattern: string; path: string; limit?: number; }
interface FindResponse { paths: string[]; truncated: boolean; }
```

端点与之一一对应：`POST /bash/exec`、`POST /bash/cancel`、`POST /fs/read`、`POST /fs/write`、`POST /fs/mkdir`、`POST /fs/access`、`POST /fs/stat`、`POST /fs/readdir`、`POST /grep`、`POST /find`。

### 2.3 Session 服务（protocol/session.ts）

```ts
interface CreateSessionRequest  { id?: string; cwd: string; parentSession?: string; }
interface CreateSessionResponse { sessionId: string; }
interface AppendEntryRequest    { entry: string; }        // 单行 JSONL（序列化后的 SessionEntry）
interface RewriteEntriesRequest { entries: string[]; }    // 全量（含 header）
interface ListSessionsQuery     { cwd?: string; }
interface ForkSessionResponse   { sessionId: string; }
```

端点：`POST /sessions`、`GET /sessions/:id/entries`（NDJSON）、`POST /sessions/:id/entries`、`PUT /sessions/:id/entries`、`GET /sessions`、`POST /sessions/:id/fork`。

## 3. 模块详细设计

### 3.1 Sandbox Worker（sandbox/）

**server.ts**：`node:http` 原生服务。路由 → JSON body 解析（限制 64MB）→ handler → JSON 响应。handler 抛 `JailError` → 403 `path_escape`；其余异常 → 500 `internal`。

**jail.ts**：

```ts
async function resolveJailPath(root: string, input: string): Promise<string> {
  const resolved = resolve(root, input);                 // 相对路径相对 root 解析
  const real = await realpath(resolved).catch(() => resolved); // 存在则解符号链接
  if (real !== root && !real.startsWith(root + sep)) throw new JailError(input);
  return real;
}
```

所有 fs/bash/search handler 的第一行必须过 `resolveJailPath`。bash 的 `cwd` 同样过 jail。

**env.ts**：白名单 `{ PATH, HOME, LANG, LC_ALL, TERM, TMPDIR }`，从 worker 进程 env 中拷贝这几个键，其余丢弃。worker 自身启动时也不读任何敏感文件。

**exec.ts**：

```ts
const running = new Map<string, ChildProcess>();  // opId → child

// POST /bash/exec
// 1. opId 冲突 → 409 conflict；cwd 过 jail
// 2. spawn(shell, { cwd, env: scrubbedEnv(), detached: true })（复用 shell 解析逻辑，见下）
// 3. 收集 stdout/stderr 到 Buffer（上限 32MB，超限截断标记）
// 4. timeout（秒）→ killProcessTree(pid)，响应 timedOut: true
// 5. 进程退出 → 从 running 移除，返回 { stdout, stderr, exitCode, timedOut }

// POST /bash/cancel：查 running，有则 killProcessTree → { cancelled: true }；无 → false
```

进程树杀法与 shell 解析（`/bin/bash` → PATH → `sh`）复用 `coding-agent/src/core/tools/shell.ts` 的 `killProcessTree` / `getShellConfig`——抽取为共享 util 或按上游代码复制到 managed（首选抽取到 managed 内独立实现，避免 coding-agent 反向依赖）。

**search.ts**：spawn `rg --json` / `fd`，stdout 全量收集后解析，按 `limit` 截断并置 `truncated`。rg/fd 二进制随 worker 部署（镜像内置或 PATH 提供），不做自动下载。

### 3.2 Sandbox Client 与远程 Operations（client/）

**sandbox-client.ts**：

```ts
class SandboxClient {
  constructor(private baseUrl: string, private token?: string) {}
  async call<Req, Res>(path: string, body: Req): Promise<Res>; // fetch POST，错误体 → Error(message)
}
```

**operations.ts**：逐接口实现，映射关系：

| 接口 | 成员 | 实现 |
|---|---|---|
| `BashOperations` | `exec(command, cwd, {onData, signal, timeout})` | 生成 `opId` → `call("/bash/exec")`；`signal` abort → `call("/bash/cancel")` 并抛 `Error("aborted")`；响应后**一次性** `onData(stdout)` / `onData(stderr)`；`timedOut` → 抛 `Error("timeout:"+timeout)`；返回 `{ exitCode }` |
| `ReadOperations` | `readFile` / `access` / `detectImageMimeType` | `/fs/read`（base64 → Buffer）；`/fs/access`；mime 检测保持本地（magic bytes 在已读 Buffer 上做） |
| `WriteOperations` | `writeFile` / `mkdir` | `/fs/write`、`/fs/mkdir` |
| `EditOperations` | `readFile` / `writeFile` / `access` | 同 fs 端点（edit 的文本替换逻辑留在 runtime 侧工具内） |
| `GrepOperations` | `isDirectory` / `readFile` | `/fs/stat`、`/fs/read`（grep 主路径走 `/grep` 端点；context 读取走 `/fs/read`） |
| `FindOperations` | `exists` / `glob` | `/fs/access`；glob → `/find` |
| `LsOperations` | `exists` / `stat` / `readdir` | `/fs/access`、`/fs/stat`、`/fs/readdir` |

错误语义对齐本地实现：文件不存在 → throw `ENOENT` 风格 Error（工具内已有对应处理）；`path_escape` → 普通 Error（会以 tool error 形式回给模型）。

### 3.3 SessionStore 重构（coding-agent，本方案唯一侵入性改动）

**现状 fs 调用点**（全部在 `session-manager.ts`）：`loadEntriesFromFile:500`、`readSessionHeader:544`、`findMostRecentSession:572`、`listSessionsFromDir:747`、`buildSessionInfo:623`、`_rewriteFile:910`、`_persist:946`、`forkFrom:1490`。

**接口**（PRD 5.2 已定义，此处为实现契约）：

```ts
interface SessionStore {
  load(sessionRef: string): Promise<string[]>;
  append(sessionRef: string, line: string): Promise<void>;
  rewrite(sessionRef: string, lines: string[]): Promise<void>;
  flush(sessionRef: string): Promise<void>;
  list(cwd?: string): Promise<SessionInfo[]>;
  fork(sourceRef: string): Promise<string>;
}
```

**LocalSessionStore**：原样抽取现有逻辑，包括 deferred-first-write 语义（`flushed` 标志：首个 assistant 消息前只缓冲，到达后 `wx` 创建并全量写入，之后 `appendFileSync`）。`append`/`rewrite` 同步完成后立即 resolve；`flush` 为 no-op。行为与上游逐字节一致。

**RemoteSessionStore**：

```ts
class RemoteSessionStore implements SessionStore {
  private queues = new Map<string, Promise<void>>();  // ref → 写链（保序）
  private pending = new Map<string, string[]>();      // ref → 未 flush 的 append
  private created = new Set<string>();                // 已在服务端创建的 ref

  append(ref, line) { pending.get(ref).push(line); return Promise.resolve(); }
  flush(ref) {
    // 入队到 queues[ref] 尾部：
    //   若 !created → POST /sessions（header 行）+ 逐条 POST entries（含全部 pending）
    //   否则 → 逐条 POST pending 中的 entries
    // 清空 pending；返回该链 promise
  }
  rewrite(ref, lines) { /* 入队：PUT /sessions/:id/entries，同步等待 */ }
  load(ref) { /* GET /sessions/:id/entries → 按行拆分 */ }
  fork(ref) { /* POST /sessions/:id/fork → 新 ref */ }
  list(cwd) { /* GET /sessions?cwd= */ }
}
```

要点：单 ref 内所有写操作串在一条 Promise 链上保序；`flush` 之前的 `append` 只进内存（崩溃丢失粒度 = 最后一个 turn，与 PRD 一致）；`rewrite`/`fork` 必须 await。

**SessionManager 改造点**：

1. 构造函数新增 `store: SessionStore`（默认 `LocalSessionStore`），`sessionFile` 语义泛化为 `sessionRef`（本地为路径，远程为 `managed://sessions/<id>`）。
2. `_persist(entry)` → 序列化后 `void store.append(ref, line)`（不 await；deferred 语义由 store 内部处理）。
3. `_rewriteFile()` → `void store.rewrite(ref, lines)`（排队执行）。
4. 新增 `flushStore(): Promise<void>` → `store.flush(ref)`。
5. 新增异步工厂 `SessionManager.openWithStore(store, ref, cwdOverride?)` / `createWithStore(store, cwd, options?)`：先 `store.load` 填充 `fileEntries`/`byId`/`leafId`，再走现有私有构造。现有同步工厂保留，内部委托 `LocalSessionStore`。
6. `list`/`listAll`/`continueRecent`/`forkFrom` 增加 store 参数重载（默认 Local）。

**flush 挂接点**：`agent-session.ts` 的 `_handleAgentEvent` 中，`message_end` 且 `message.role === "assistant"` 的 `appendMessage` 之后，调用 `void this.sessionManager.flushStore()`（本地 store 为 no-op，零行为差异）。

### 3.4 Session Service（session-service/）

**存储布局**：`<dataDir>/sessions/<sessionId>.jsonl`，与上游文件格式逐字节一致（header + entry 行）。

**server.ts**：

- `POST /sessions`：校验 id（或生成 uuidv7），写 header 行；id 冲突 → 409。
- `GET /sessions/:id/entries`：读文件，NDJSON 原样返回。
- `POST /sessions/:id/entries`：**per-session 写锁**（`Map<sessionId, Promise>` 链）内 appendFile 一行。
- `PUT /sessions/:id/entries`：写锁内全量重写（先写临时文件再 rename，防半写）。
- `GET /sessions`：扫目录读各文件 header 行（带 mtime 缓存）。
- `POST /sessions/:id/fork`：写锁内复制文件、生成新 id、改写 header（id/timestamp/parentSession）。

### 3.5 managed CLI（cli.ts）

```
managed sandbox --root <dir> --port <p>     # 启动 Sandbox Worker
managed session --data-dir <dir> --port <p> # 启动 Session Service
managed run --cwd <dir> [--prompt <text>]   # 组合演示：拉起两服务 + 以远程模式启动 pi
```

`managed run` 仅作 demo/集成测试用：子进程方式启动两服务（临时端口、临时目录），设置 `PI_SESSION_URL`/`PI_SANDBOX_URL` 后 exec pi。

## 4. coding-agent 接线点（精确清单）

| # | 位置 | 改动 | 性质 |
|---|---|---|---|
| 1 | `agent-session.ts:2542`（`_buildRuntime` 内 `createAllToolDefinitions` 调用处） | 当 `resolveManagedConfig().sandboxUrl` 存在时，为 7 个工具的 options 各注入对应远程 operations（与现有 `read: {autoResizeImages}`、`bash: {commandPrefix, shellPath}` 合并） | additive 分支 |
| 2 | `agent-session.ts` `_handleAgentEvent` | assistant `message_end` 的 `appendMessage` 后加 `void this.sessionManager.flushStore()` | additive 一行 |
| 3 | `session-manager.ts` | §3.3 的 store 抽象与工厂重载 | 重构，外部 API 不变 |
| 4 | `main.ts` `createSessionManager()` | 当 `PI_SESSION_URL` 存在时改用 `createWithStore(RemoteSessionStore)` | additive 分支 |

配置读取集中在 `packages/managed/src/config.ts` 的 `resolveManagedConfig()`，coding-agent 侧只读其结果，不直接散落读 env。

## 5. 关键流程

### 5.1 一个 prompt turn（远程模式）

```
user → runtime: prompt
runtime → provider: streamSimple（直连，env key）
provider → runtime: 流式 token
runtime → sandbox: POST /fs/read（工具调用）
sandbox → runtime: { content }
runtime → provider: 带 toolResult 继续
provider → runtime: assistant 完成
runtime: appendMessage(assistant) → RemoteSessionStore.append（入内存队列）
runtime: flushStore() → POST /sessions/:id/entries（队列落远程）
runtime → user: 输出
```

### 5.2 用户中断（abort）

```
user: Esc → AbortSignal.abort()
runtime: bash 工具的 signal 触发 → POST /bash/cancel { opId }
sandbox: killProcessTree(pid) → exec 响应 exitCode: null
runtime: 工具抛 "aborted" → agent loop 终止 turn
```

### 5.3 runtime 崩溃恢复

```
runtime 崩溃（turn 边界后）
外部控制面: 同 sessionId 唤醒新 runtime
新 runtime: RemoteSessionStore.load → GET /sessions/:id/entries → 重建内存索引
新 runtime: 继续对话（丢失最多最后一个未完成 turn）
```

## 6. 错误处理约定

| 场景 | 约定 |
|---|---|
| 协议错误 | `{error:{code,message}}`，HTTP 4xx/5xx；client 解为 `Error(message)` |
| bash abort | client 抛 `Error("aborted")`（与本地实现一致） |
| bash 超时 | worker 杀进程树，响应 `timedOut:true`；client 抛 `Error("timeout:<n>")`（与本地一致） |
| 文件不存在 | worker 404 `not_found`；client 抛 ENOENT 风格 Error |
| 路径逃逸 | worker 403 `path_escape`；以 tool error 回模型 |
| 网络失败 | 幂等读（load/list/stat 类）client 重试 1 次；写（append/rewrite/exec）不重试，失败即上抛 |
| session 写队列失败 | flush 拒绝 → agent-session 记录 error 事件，不中断对话（下轮 flush 重试） |

## 7. 测试方案

| 层 | 内容 | 工具 |
|---|---|---|
| 单元 | jail 路径（含符号链接逃逸用例）、协议编解码、RemoteSessionStore 写队列保序与 flush 语义、env 白名单 | vitest + tmpdir |
| 服务 | sandbox 各端点（起 worker 于临时 root）；session service 各端点（临时 dataDir） | vitest + node:http |
| 集成 | `managed run`：两服务 + faux provider 跑完整 turn（读文件→改文件→bash→恢复 session） | 沿用 `test/suite/harness.ts` 风格 |
| 回归 | `npm run check`、`./test.sh` 全绿 | 仓库现有 |

## 8. 任务分解（对齐 PRD 里程碑）

**M1 执行分离**
1. `packages/managed` 骨架 + protocol/sandbox.ts + errors.ts
2. sandbox/：jail、env、exec（含 opId 注册表与 cancel）、search、server
3. client/：sandbox-client + 7 个远程 operations
4. 接线点 #1（`_buildRuntime` 注入分支）
5. 单元 + 服务端点测试

**M2 Session 分离**
6. SessionStore 接口 + LocalSessionStore 抽取 + SessionManager 改造（接线点 #3）
7. session-service/：store + server
8. RemoteSessionStore + 接线点 #2（flush）、#4（main.ts 分支）
9. 写队列与恢复测试

**M3 组合 demo**
10. managed CLI（sandbox/session/run）
11. 集成测试 + 使用文档（packages/managed/README.md）
