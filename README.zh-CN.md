# coding-agent

[English](README.md) | 简体中文

基于 TypeScript 的 Coding Agent 应用，包含模型调用、工具执行、上下文管理、记忆、安全护栏，以及 CLI、飞书、定时任务和子 Agent 入口。

> **维护状态**：本仓库保留 coding-agent 完整应用的历史实现，供学习和回顾。这里不再计划继续开发；可复用核心的后续开发与维护在 [Knolume Runtime](https://github.com/winhok/Knolume-runtime) 进行。新项目需要集成或扩展运行时，请从新仓库开始。

## 与 Knolume-runtime 的关系

本仓库把运行时与应用组装放在同一个包中：`src/main.ts` 连接模型、工具、配置和各类入口，`src/index.ts` 启动 CLI。Knolume-runtime 将通用能力整理为独立的 `@knolume/runtime` 库，供宿主应用组合使用。

| 能力 | coding-agent 中的历史实现 | Knolume-runtime 中的对应模块 |
| --- | --- | --- |
| Agent 循环、重试、循环检测和事件 | `src/agent/` | `src/harness/agent/`，通过 `AgentToolRuntime` 接口获取工具 |
| 工具注册、执行、权限与审批 | `src/tools/`、`src/security/` | `src/tools/`，由宿主提供工具实现与权限策略 |
| 上下文、记忆、检索与会话 | `src/context/`、`src/memory/`、`src/rag/`、`src/session/` | `src/harness/` 下的对应模块 |
| Skills、子 Agent、轨迹与用量 | `src/skills/`、`src/agents/`、`src/trace/`、`src/usage/` | `src/harness/` 下的对应模块 |
| 安全护栏 | `src/guardrails/` 中的应用策略与执行逻辑 | 通用护栏执行接口，具体规则、身份上下文和检查模型由宿主提供 |
| 应用入口与传输 | CLI、飞书、Cron 和内置文件、Shell、Git 等工具 | 独立库及 `src/protocol/` 协议定义；应用入口、HTTP/SSE 服务和具体产品工具由宿主实现 |

这里的迁移是核心能力的抽取与后续演进，不代表两个仓库的 API、配置文件或持久化数据格式可以直接互换。本仓库仍保留原有实现，没有改为依赖 `@knolume/runtime`；CLI、飞书和 Cron 也不是新库自带的应用入口。

新项目请参考 [Knolume-runtime 的接入说明](https://github.com/winhok/Knolume-runtime#use-in-an-application) 和 [可运行示例](https://github.com/winhok/Knolume-runtime/tree/main/examples)。迁移现有应用时，需要按新库接口接入模型、提示词、工具、权限与审批，并单独核对会话、记忆和配置的兼容性。

## 本仓库保留的核心实现

| 能力 | 实现位置 |
| --- | --- |
| Model loop：模型调用、工具调用循环、重试与循环检测 | `src/agent/`、`src/models.ts` |
| Tool execution：工具执行与权限控制 | `src/tools/`、`src/security/` |
| MCP：连接外部工具服务 | `src/tools/mcp-client.ts` |
| Context：提示词组装、上下文压缩与项目规则 | `src/context/` |
| Memory：记忆存储、检索与校验 | `src/memory/` |
| Guardrails：输入、工具参数、最终输出检查，语义检查、脱敏、审计、Owner 审批与执行准入 | `src/guardrails/` |
| Tracing：执行轨迹记录与查看 | `src/trace/` |
| Sessions：会话持久化与恢复 | `src/session/` |
| Evaluation：护栏基线评估与真实模型冒烟评估 | `evals/` |

## 本仓库的应用入口

Coding Agent 使用上述运行时，组合文件读写、代码检索、终端执行与子 Agent 等工具，支持交互问答、单次任务和只读规划。应用组装入口位于 `src/main.ts`，CLI 入口位于 `src/index.ts`；目前运行时与参考应用仍在同一个包中。

## 本地运行（历史应用）

安装 Node.js 和 `package.json` 指定版本的 pnpm，然后执行：

```sh
pnpm install
pnpm run init
pnpm start
```

初始化向导生成配置，并提示设置模型凭证。为兼容已有安装，配置文件仍使用 `super-agent.config.json`；会话、记忆等数据路径保持原有配置。

```sh
pnpm start --help
pnpm start ask "解释这个项目的结构"
pnpm start plan "分析如何添加一个工具"
pnpm start --continue
```

包名和可执行命令均为 `coding-agent`。构建后也可直接执行：

```sh
pnpm build
node dist/index.js --help
```

`ask` 和 `plan` 默认只开放只读工具；`plan` 始终只读。交互模式默认询问审批，`--approval-mode always` 会自动批准敏感操作。

## 验证

```sh
pnpm typecheck
pnpm test
pnpm eval
```

`pnpm eval:smoke` 单独运行真实模型评估，需要有效模型配置并会调用外部模型服务。离线测试和评估不代表真实模型或飞书等外部系统已验收。
