# AGENTS.md

本目录实现 ACP Client：一个基于 `@agentclientprotocol/sdk` 的 ACP v1 客户端 SDK。一个 `AcpClient` 对应一个 Agent 子进程和一条 NDJSON 连接；`AcpSession` 负责该连接上的单个会话状态。

## 目录职责

| 路径                       | 职责                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `client/client.ts`         | `AcpClient`：启动/销毁进程、初始化、认证、会话生命周期、unstable 请求、事件与客户端快照 |
| `process.ts`               | 子进程 spawn、stderr 采集、退出监听、进程组终止                                         |
| `sdk/profile.ts`           | stable/unstable SDK profile；unstable 只在启用时动态加载                                |
| `capabilities.ts`          | 根据宿主回调生成 `ClientCapabilities`，以及 Agent 能力检查                              |
| `session/session.ts`       | `AcpSession` 公开 API、prompt/cancel/config/mode、`session.experimental`                |
| `session/state.ts`         | 会话内部可变状态                                                                        |
| `session/reducers.ts`      | `SessionUpdate` → 内部状态的同步 reducer                                                |
| `session/snapshot.ts`      | 只读快照构建与派生字段                                                                  |
| `session/config.ts`        | `configOptions` 归一化、mode/model 提取                                                 |
| `session/content.ts`       | prompt 归一化、内容能力校验、`content` helpers                                          |
| `unstable/experimental.ts` | `client.experimental` 的实现                                                            |
| `unstable/methods.ts`      | unstable 方法名常量                                                                     |
| `types/public.ts`          | 公开类型：选项、快照、事件、宿主回调                                                    |
| `errors.ts`                | `AcpError` 体系与 `mapRequestError`                                                     |
| `events.ts`                | 类型化事件订阅器                                                                        |
| `index.ts`                 | 包入口导出                                                                              |

## 核心不变量

1. **一个 Client 一个进程。** 不要在一个 `AcpClient` 内隐式创建第二个 Agent 进程；`--process-per-session` 等参数只是透传给 Agent。
2. **`start()` 显式启动。** 未 ready 时调用会话方法抛 `AcpNotStartedError`；`dispose()` 必须幂等，并拒绝所有 pending 请求。
3. **stable 与 unstable 不能混用。** 启用 `experimental.unstable` 后，整条连接统一使用 `@agentclientprotocol/sdk/unstable` 的 app、stream 和 schema。stable 路径不得静态引入 unstable 运行时。
4. **能力先检查再发请求。** 使用 `capabilities.ts` 的 `assert*Supported`，不要在调用点重复手写判断。所有 unstable 方法还要求 `profile.name === "unstable"` 且 `client.experimental` 非空。
5. **状态变更必须经过 reducer。** 不要从外部直接改 `SessionState`。每次变更要 `state.touch()`、使快照缓存失效并发事件。
6. **快照只读。** `getSnapshot()` 返回 `readonly` 结构并按 revision 缓存；不要向调用方暴露内部可变数组或对象。
7. **reducer 同步执行。** `session/update` 的处理不能 await；异步工作放到事件订阅者或宿主回调中。
8. **configOptions 优先于 modes。** `configOptions != null`（包括 `[]`）时走配置项路径；只有它为 null/absent 时才使用旧 `modes`。
9. **历史回放顺序不能乱。** `session/load` 预注册会话；config/mode 更新缓冲到响应之后；`session/new` 的未知 session 更新先暂存，响应后再按 ID 应用。
10. **子会话只读。** 子会话不能 prompt/close/delete/setMode/setConfigOption；`session/options` 与 `setTitle` 也拒绝。`status` 是只读查询，可以执行。
11. **用户消息乐观写入。** `prompt()` 先写本地 user message；首个 `user_message_chunk` 到达时替换同一条消息，避免重复。
12. **错误要保留协议信息。** 协议错误通过 `mapRequestError`；实验性会话方法的 `-32002` 映射为 `AcpSessionNotFoundError`。
13. **不要记录敏感内容。** 日志只记录生命周期、方法名和错误；不要输出 prompt 内容、文件内容、env 或 token。

## 添加新协议能力

按以下顺序改，缺一不可：

1. `types/public.ts`：公开选项、快照字段、事件、`ExperimentalApi` / `SessionExperimentalApi`。
2. `capabilities.ts`：新增 `assert*Supported`，使用 unstable `SessionCapabilities` 的窄化类型。
3. `unstable/methods.ts`：如果是 unstable 方法，加方法名常量。
4. `client/client.ts`：
   - 稳定方法走 `requestAgent`；
   - unstable 方法走 `requireUnstableContext()`；
   - 需要更新会话状态时调用 `AcpSession` 的内部方法，而不是直接改 `SessionState`。
5. `session/*`：只有状态确实变化时才加 reducer、快照字段和事件。
6. `examples/mock-agent.ts`：实现对应 handler，并用环境变量提供“缺少能力”的分支。
7. `tests/integration.test.ts`：至少覆盖成功路径、能力门控、错误映射和一个边界条件。
8. `README.md`：更新 unstable/API 文档。
9. 运行 `pnpm typecheck`、`pnpm build`、`pnpm test`。

## 编码约定

- ESM + NodeNext：相对导入必须带 `.js` 扩展名。
- 严格 TypeScript；避免 `any`、`@ts-ignore` 和 `unknown as`。跨 stable/unstable 边界的 `as` 必须集中在 `sdk/profile.ts`、`unstable/*` 或 `client.ts` 的 `requireUnstableContext` 附近。
- 新代码优先复用 `util.ts` 的路径校验、env 合并、`deferred`、`estimateBytes`，以及 `session/config.ts` 的归一化函数。
- 对外 API 的 TSDoc 描述可观察行为：零值、错误、所有权、并发、生命周期；不要复述实现。
- 注释只在解释“为什么”时添加，使用简体中文。
- 不要新增运行时依赖，除非标准库或现有依赖无法完成；新增前先说明理由。
- 公开 API 变更必须同步 `src/index.ts`、`README.md` 和测试。

## 常见陷阱

- `session/options` 是预览，不能写入当前会话的 `configOptions`。
- `session/status` 的 `agentStatus` 只是最近一次显式查询，不能据此推断 `lifecycle` 或 `canPrompt`。
- `setTitle` 成功后要更新快照并合成 `session_info_update`；不要只返回响应。
- `session/load` 响应里的初始 config 不能被响应前的 `config_option_update` 覆盖；反过来也不能丢掉这些更新。
- `session/new` 的 pending update 有数量/字节上限；溢出时必须取消 pending 请求，不能无限堆积。
- `dispose()` 期间的子进程退出是预期的，不要重复发 `exit` 事件或把状态改成 `failed`。
- 删除已关闭会话仍然要发送 `session/delete`；`deleteSession` 只对 `deleted` 状态短路。
- `closeSession` / `deleteSession` 成功后会把根会话及其子会话从 `sessionMap` 移除；`sessions`、`getSession()` 和客户端快照只保留 `loading` / `active` 会话。已关闭会话可以在同一 `AcpClient` 连接内重新 `loadSession` / `resumeSession`。
- 同一个 `AcpSession` 句柄重复 `close()` 幂等，不重复发送 `session/close`。
- 子会话的 `subagent_update` 必须先创建子会话，再把后续 child 更新路由过去。
- 不要把 `session.experimental` 暴露给 stable profile；它必须为 `null`。
