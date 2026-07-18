# 提案：M1 执行分离——Sandbox Worker 与远程工具操作

## Why

pi coding agent 目前是单体进程：7 个内置工具（read/bash/edit/write/grep/find/ls）在 agent 进程内通过 `fs`/`child_process` 直接操作本机，与 agent 同权，无安全边界；provider key 与执行环境同处一个进程空间。目标形态是云上 managed agents：工具执行全部发生在独立的 Sandbox Worker 内，Agent Runtime 不直接触碰执行环境。

**背景**：
- PRD：[docs/managed-agents-prd.md](../../../docs/managed-agents-prd.md)（§7 M1 范围）
- 接口规范：[docs/managed-agents-interface-spec.md](../../../docs/managed-agents-interface-spec.md)（§3 Sandbox Worker API）
- Anthropic managed agents 生产实践验证了同一架构方向（brain/hands 分离、沙箱即"接受输入返回字符串的工具"）

**当前状态**：工具经 `*Operations` 接口执行，默认实现为本地 fs/进程；`ToolsOptions`（`packages/coding-agent/src/core/tools/index.ts:86-94`）是现成注入点。

**期望状态**：`PI_SANDBOX_URL` 存在时，7 个工具的全部副作用发生在 Sandbox Worker 的 `--root` 内；缺省时行为与上游逐字节一致。

## What Changes

- 新增 `packages/managed` 包：sandbox 协议类型、Sandbox Worker（HTTP 服务）、sandbox client、7 个远程 `*Operations` 实现
- Sandbox Worker 安全语义：路径 jail（resolve + realpath + 前缀校验）、子进程 env 白名单、opId 取消、worker 端超时与输出截断
- 上游 additive 修补一：`GrepOperations` 增加可选 `search` hook（现状 grep 主路径在工具体内 spawn rg，注入无法接管）
- 上游 additive 修补二：`BashOperations` 增加可选溢出持久化 hook（现状溢出写到 runtime 本地 tmpdir，远程模式下对模型不可见）
- 接线：`agent-session.ts` `_buildRuntime` 在 `PI_SANDBOX_URL` 存在时注入远程 operations
- **依赖方向决策**（修正技术方案 §1.1 的自相矛盾）：coding-agent → managed 单向依赖；managed 不 import coding-agent，远程 operations 以结构化类型满足 `*Operations` 接口，在接线点由编译器校验

## Impact

### 受影响的规范
- `spec/specs/sandbox-execution/spec.md` - 新增能力（本提案创建）

### 受影响的代码
- `packages/managed/`（新包）- 协议、worker、client、远程 operations
- `packages/coding-agent/src/core/tools/grep.ts` - additive search hook
- `packages/coding-agent/src/core/tools/bash.ts` - additive 溢出持久化 hook
- `packages/coding-agent/src/core/agent-session.ts` - `_buildRuntime` additive 分支
- 根 `tsconfig.json` paths、`package-lock.json`（新 workspace）

### 用户影响
- 无 URL 时零影响（本地行为不变）；设置 `PI_SANDBOX_URL` 后工具执行转移到沙箱

### API 变更
- 无破坏性变更；新增 Sandbox Worker HTTP API（`/v1/*`，见接口规范 §3）

### 需要迁移
- [ ] 数据库迁移
- [ ] API 版本提升
- [ ] 用户沟通
- [x] 文档更新（packages/managed/README.md 随 M3 补齐）

## 时间线评估

中（新包约 2k 行 + 两处上游 additive 修补 + 契约/一致性测试）

## 风险

- **本地 fs 假设泄漏**：工具层可能还有绕过 `*Operations` 的本地访问（已核实 grep、bash 溢出两处）——缓解：M1 内系统过一遍 7 个工具，行为一致性套件兜底
- **rg/fd 可用性**：worker 依赖 PATH 中的 rg/fd——缓解：search 端点测试按二进制可用性条件跳过，镜像分发是部署侧责任
- **新 workspace 影响仓库检查**：`npm run check` 的 tsgo/biome/pinned-deps 覆盖新包——缓解：零新增运行时依赖，devDeps 与现有包同版本钉死
