# 规范差异：sandbox-execution

本文件包含对 `spec/specs/sandbox-execution/spec.md` 的规范变更（全新能力）。

本变更替换了先前设计中 HTTP/JSON + 多端点的方案，改为 gRPC + protobuf 单服务入口。原方案在实现过程中暴露两个问题：协议名实不符（自称 RPC 却走 REST 端点）、协议层枚举工具类型（每加一个工具要改四处）。本版本修正这两点。

## ADDED 需求

### Requirement: 沙箱 gRPC 协议
WHEN Agent Runtime 需要执行工具操作,
系统 SHALL 通过 gRPC 调用 Sandbox Worker 的 `Sandbox.Call` unary RPC,
AND 请求携带 `op`（工具名，字符串）与 `args`（工具参数，`google.protobuf.Struct`）,
AND 不在协议层枚举工具类型——新工具只需 worker 内部实现 handler，proto 与生成的 stub 无需变更,
AND 响应为 `{ ok: { result } }` 或 `{ error: { code, message } }` 二选一,
AND 二进制内容用 proto `bytes` 字段，不 base64 内嵌,
AND transport 层错误（gRPC status `UNAVAILABLE` 等）与业务错误（`error.code` 如 `not_found`）分离,
AND 流式扩展不堵死——proto 可通过新增 `stream` 修饰的 RPC 方法（如 `rpc StreamCall(stream CallRequest) returns (stream CallResponse)`）支持 bash 实时输出等场景，M1 不实现该流式方法但服务定义保留扩展空间。

#### Scenario: 正常调用
GIVEN Sandbox Worker 以 `--root /tmp/work` 运行
WHEN Runtime 发送 `Call { op: "fs.read", args: { path: "a.txt" } }`
THEN 响应为 `ok: { content: <bytes> }` 且 `content` 为该文件字节

#### Scenario: 业务错误
GIVEN 请求的路径不存在
WHEN Runtime 发送 `Call { op: "fs.read", args: { path: "missing.txt" } }`
THEN 响应为 `error: { code: "not_found", message: ... }`

#### Scenario: 工具扩展无需协议变更
GIVEN worker 新增 handler "git.diff"
WHEN Runtime 发送 `Call { op: "git.diff", args: {...} }`
THEN 协议层透明传递至 worker handler
AND proto 定义、client stub、server 骨架均无需修改

#### Scenario: transport 与业务错误分离
GIVEN worker 尚未启动
WHEN Runtime 发送 `Call` 请求
THEN gRPC 返回 status `UNAVAILABLE`（transport 层）
AND 不返回业务 `error` 字段（应用层）

---

### Requirement: protobuf 服务定义作为单一事实源
WHEN 定义沙箱 gRPC 服务,
系统 SHALL 在 `proto/sandbox/v1/sandbox.proto` 中声明服务与消息,
AND client 与 server 实现均从该 proto codegen,
AND 不得手工同步接口形状。

```proto
syntax = "proto3";

package pi.sandbox.v1;

import "google/protobuf/struct.proto";
import "google/protobuf/empty.proto";

service Sandbox {
  rpc Call(CallRequest) returns (CallResponse);
  rpc Healthz(google.protobuf.Empty) returns (HealthzResponse);
}

message CallRequest {
  string op = 1;
  google.protobuf.Struct args = 2;
  optional string op_id = 3;
  optional uint32 timeout_ms = 4;
}

message CallResponse {
  oneof outcome {
    google.protobuf.Struct ok = 1;
    Error error = 2;
  }
}

message Error {
  string code = 1;
  string message = 2;
}

message HealthzResponse {
  bool ok = 1;
}
```

#### Scenario: proto 是契约
GIVEN 任何客户端实现
WHEN 从 proto 生成 stub
THEN 与 worker 的 server stub 类型一致
AND 无需手工同步接口

---

### Requirement: 路径 jail
WHEN Sandbox Worker 收到任何含路径的请求（含 bash 的 cwd）,
系统 SHALL 将路径解析后校验其等于 root 或以 root 为前缀（经 realpath 解符号链接）,
AND 对越出 root 的请求拒绝执行并返回业务错误 `error.code = "path_escape"`。

#### Scenario: 相对路径逃逸
GIVEN worker root 为 /tmp/work
WHEN 请求 `Call { op: "fs.read", args: { path: "../../etc/passwd" } }`
THEN 响应为 `error: { code: "path_escape" }` 且文件未被读取

#### Scenario: 符号链接逃逸
GIVEN /tmp/work/link 是指向 /etc 的符号链接
WHEN 请求 `Call { op: "fs.read", args: { path: "link/passwd" } }`
THEN 响应为 `error: { code: "path_escape" }`

---

### Requirement: 子进程环境白名单
WHEN Sandbox Worker 执行 bash 命令,
系统 SHALL 仅以白名单变量（PATH/HOME/LANG/LC_ALL/TERM/TMPDIR）加请求级 env 构造子进程环境,
AND 不继承 worker 进程环境的其余变量。

#### Scenario: worker env 不泄漏
GIVEN worker 进程环境含 `SECRET_TOKEN=abc123`
WHEN 通过 `Call { op: "bash.exec", args: { command: "env", cwd: "." }, op_id: "b1" }` 执行
THEN stdout 不含 `SECRET_TOKEN`

#### Scenario: 请求级 env 合并
GIVEN 请求 `args: { command: "echo $FOO", env: { FOO: "bar" }, cwd: "." }`
WHEN 执行完成
THEN stdout 为 `bar`

---

### Requirement: bash 取消与超时
WHEN Runtime 发送 `Call { op: "bash.exec", args: { command, cwd }, op_id: "x1" }`,
系统 SHALL 以 opId 注册运行中的进程,
AND 同 opId 的 `Call { op: "bash.cancel", args: { op_id: "x1" } }` 杀死对应进程树,
AND `timeout_ms` 到期时杀死进程树并在响应中置 `error.code = "timeout"`。

#### Scenario: 取消运行中的命令
GIVEN 一个 `sleep 100` 的 exec 请求以 opId "x1" 在途
WHEN Runtime 发送 `Call { op: "bash.cancel", args: { op_id: "x1" } }`
THEN cancel 响应 `ok: { cancelled: true }`
AND 原 exec 响应 `ok: { exit_code: null }`
AND 进程树已不存在

#### Scenario: 取消不存在的 opId
WHEN Runtime 对未注册的 opId 发送 cancel
THEN 响应 `ok: { cancelled: false }`

#### Scenario: 超时
GIVEN 请求 `args: { command: "sleep 100", cwd: "." }, timeout_ms: 1000`
WHEN 1000ms 到期
THEN 响应 `error: { code: "timeout" }` 且 `ok` 字段缺省

---

### Requirement: bash 输出上限
WHEN bash 命令的 stdout 或 stderr 超过 32MB,
系统 SHALL 截断该流并在响应的 `ok` 字段中置对应 `stdout_truncated`/`stderr_truncated` 为 true。

#### Scenario: 输出截断
GIVEN 命令输出超过 32MB
WHEN exec 完成
THEN 响应 `ok` 含截断后的输出且 `stdout_truncated: true`

---

### Requirement: 远程工具操作行为一致性
WHEN 通过远程 `*Operations` 执行工具操作,
系统 SHALL 产生与本地实现一致的结果与错误形状,
AND 文件不存在抛 ENOENT 风格错误（映射自 `error.code = "not_found"`）,
AND 用户中断抛 `Error("aborted")`,
AND 超时抛 `Error("timeout:<n>")`（映射自 `error.code = "timeout"`）。

#### Scenario: 行为一致
GIVEN 同一组文件系统与命令场景
WHEN 分别用本地 operations 与远程 operations（对真实 worker）执行
THEN 两者的返回结果与抛出的错误形状一致

---

### Requirement: 沙箱冷启动容忍
WHEN `PI_SANDBOX_URL` 指向的端点尚未就绪（scale-from-zero）,
系统 SHALL 对 gRPC `UNAVAILABLE` 在 60s 预算内指数退避重试,
AND 请求字节一旦发出即不再重试写操作（non-idempotent op 只在连接失败时重试，已发送后失败直接抛）,
AND Runtime 启动时不做任何沙箱握手或健康检查,
AND idempotent op（如 `fs.read`/`fs.stat`）允许在 5xx/network 失败时多一次重试。

#### Scenario: 冷启动后成功
GIVEN worker 在首个请求后 2 秒才开始监听
WHEN Runtime 发起工具调用
THEN 调用在 worker 就绪后成功完成

#### Scenario: 写操作不重试
GIVEN 一个 `fs.write` 请求已发送至 worker 但响应丢失
WHEN 客户端检测到失败
THEN 不重试该 `fs.write` 调用

---

### Requirement: 本地回落
WHEN `PI_SANDBOX_URL` 未设置,
系统 SHALL 使用本地 `*Operations` 实现,
AND 行为与上游完全一致。

#### Scenario: 缺省行为不变
GIVEN 未设置任何 managed 环境变量
WHEN 运行现有测试套件
THEN 全部通过

---

### Requirement: grep 远程搜索 hook
WHEN `GrepOperations` 提供可选 `search` 成员,
系统 SHALL 使用该实现执行搜索并跳过本地 rg spawn,
AND 未提供时保持现有本地 rg 行为,
AND 远程实现经 `Call { op: "grep", args: { pattern, path, ... } }` 执行。

#### Scenario: 远程接管搜索
GIVEN 注入了带 search 成员的自定义 GrepOperations
WHEN 执行 grep 工具调用
THEN 搜索经自定义实现完成且本地不 spawn rg

---

### Requirement: bash 溢出输出沙箱可见
WHEN `BashOperations` 提供可选溢出持久化 hook 且输出被截断,
系统 SHALL 以该 hook 的返回值作为 `fullOutputPath`,
AND 远程实现的 hook 经 `Call { op: "fs.write", args: {...} }` 将完整输出写入沙箱内路径。

#### Scenario: 远程溢出可读
GIVEN 远程模式下一次输出超过截断阈值的 bash 调用
WHEN 工具结果返回 `fullOutputPath`
THEN 该路径位于沙箱内且可经 `Call { op: "fs.read" }` 读回完整输出
