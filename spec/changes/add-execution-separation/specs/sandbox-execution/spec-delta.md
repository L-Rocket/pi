# 规范差异：sandbox-execution

本文件包含对 `spec/specs/sandbox-execution/spec.md` 的规范变更（全新能力）。

## ADDED 需求

### Requirement: 沙箱 RPC 协议
WHEN Agent Runtime 需要执行工具操作,
系统 SHALL 通过 HTTP/JSON 请求-响应调用 Sandbox Worker 的 `/v1/*` 端点,
AND 不使用流式或持久连接,
AND 二进制内容以 base64 内嵌 JSON,
AND 错误统一为 `{ error: { code, message } }` 格式。

#### Scenario: 正常调用
GIVEN Sandbox Worker 以 `--root /tmp/work` 运行
WHEN Runtime 发送 `POST /v1/fs/read` `{ path: "a.txt" }`
THEN 响应为 200 且 `{ content }` 为该文件的 base64 内容

#### Scenario: 错误格式
GIVEN 请求的路径不存在
WHEN Runtime 发送 `POST /v1/fs/read`
THEN 响应为 404 且 body 为 `{ error: { code: "not_found", message } }`

---

### Requirement: 路径 jail
WHEN Sandbox Worker 收到任何含路径的请求（含 bash 的 cwd）,
系统 SHALL 将路径解析后校验其等于 root 或以 root 为前缀（经 realpath 解符号链接）,
AND 对越出 root 的请求拒绝执行。

#### Scenario: 相对路径逃逸
GIVEN worker root 为 /tmp/work
WHEN 请求 `POST /v1/fs/read` `{ path: "../../etc/passwd" }`
THEN 响应为 403 `path_escape` 且文件未被读取

#### Scenario: 符号链接逃逸
GIVEN /tmp/work/link 是指向 /etc 的符号链接
WHEN 请求 `POST /v1/fs/read` `{ path: "link/passwd" }`
THEN 响应为 403 `path_escape`

---

### Requirement: 子进程环境白名单
WHEN Sandbox Worker 执行 bash 命令,
系统 SHALL 仅以白名单变量（PATH/HOME/LANG/LC_ALL/TERM/TMPDIR）加请求级 env 构造子进程环境,
AND 不继承 worker 进程环境的其余变量。

#### Scenario: worker env 不泄漏
GIVEN worker 进程环境含 `SECRET_TOKEN=abc123`
WHEN 通过 `/v1/bash/exec` 执行 `env`
THEN stdout 不含 `SECRET_TOKEN`

#### Scenario: 请求级 env 合并
GIVEN 请求 `{ command: "echo $FOO", env: { FOO: "bar" } }`
WHEN 执行完成
THEN stdout 为 `bar`

---

### Requirement: bash 取消与超时
WHEN Runtime 发送 `/v1/bash/exec`,
系统 SHALL 以请求携带的 opId 注册运行中的进程,
AND 在收到同 opId 的 `/v1/bash/cancel` 时杀死对应进程树,
AND 在请求 timeout（秒）到期时杀死进程树并响应 `timedOut: true`。

#### Scenario: 取消运行中的命令
GIVEN 一个 `sleep 100` 的 exec 请求以 opId "x1" 在途
WHEN Runtime 发送 `POST /v1/bash/cancel` `{ opId: "x1" }`
THEN cancel 响应 `{ cancelled: true }`
AND exec 响应 `exitCode: null`
AND 进程树已不存在

#### Scenario: 取消不存在的 opId
WHEN Runtime 对未注册的 opId 发送 cancel
THEN 响应 `{ cancelled: false }`

#### Scenario: 超时
GIVEN 请求 `{ command: "sleep 100", timeout: 1 }`
WHEN 1 秒到期
THEN 响应 `timedOut: true` 且 `exitCode: null`

---

### Requirement: bash 输出上限
WHEN bash 命令的 stdout 或 stderr 超过 32MB,
系统 SHALL 截断该流并在响应中置对应 `stdoutTruncated`/`stderrTruncated` 为 true。

#### Scenario: 输出截断
GIVEN 命令输出超过 32MB
WHEN exec 完成
THEN 响应含截断后的输出且 `stdoutTruncated: true`

---

### Requirement: 远程工具操作行为一致性
WHEN 通过远程 `*Operations` 执行工具操作,
系统 SHALL 产生与本地实现一致的结果与错误形状,
AND 文件不存在抛 ENOENT 风格错误,
AND 用户中断抛 `Error("aborted")`,
AND 超时抛 `Error("timeout:<n>")`。

#### Scenario: 行为一致
GIVEN 同一组文件系统与命令场景
WHEN 分别用本地 operations 与远程 operations（对真实 worker）执行
THEN 两者的返回结果与抛出的错误形状一致

---

### Requirement: 沙箱冷启动容忍
WHEN `PI_SANDBOX_URL` 指向的端点尚未就绪（scale-from-zero）,
系统 SHALL 对连接失败在 60s 预算内指数退避重试,
AND 请求字节一旦发出即不再重试写操作,
AND Runtime 启动时不做任何沙箱握手或健康检查。

#### Scenario: 冷启动后成功
GIVEN worker 在首个请求后 2 秒才开始监听
WHEN Runtime 发起工具调用
THEN 调用在 worker 就绪后成功完成

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
AND 未提供时保持现有本地 rg 行为。

#### Scenario: 远程接管搜索
GIVEN 注入了带 search 成员的自定义 GrepOperations
WHEN 执行 grep 工具调用
THEN 搜索经自定义实现完成且本地不 spawn rg

---

### Requirement: bash 溢出输出沙箱可见
WHEN `BashOperations` 提供可选溢出持久化 hook 且输出被截断,
系统 SHALL 以该 hook 的返回值作为 `fullOutputPath`,
AND 远程实现的 hook 经 `/v1/fs/write` 将完整输出写入沙箱内路径。

#### Scenario: 远程溢出可读
GIVEN 远程模式下一次输出超过截断阈值的 bash 调用
WHEN 工具结果返回 `fullOutputPath`
THEN 该路径位于沙箱内且可经 `/v1/fs/read` 读回完整输出
