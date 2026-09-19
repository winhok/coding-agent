# Runframe

**General-purpose Agent Runtime**

A reusable TypeScript runtime for tool-using agents, with a coding agent as its reference implementation.

Runframe 将模型调用、工具执行、上下文、记忆与安全检查组织为可复用的 Agent 运行时。当前以 Coding Agent 作为完整参考应用，提供 CLI、飞书、定时任务和子 Agent 执行入口。

## Core Runtime

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

## Reference Application: Coding Agent

Coding Agent 使用上述运行时，组合文件读写、代码检索、终端执行与子 Agent 等工具，支持交互问答、单次任务和只读规划。应用组装入口位于 `src/main.ts`，CLI 入口位于 `src/index.ts`；目前运行时与参考应用仍在同一个包中。

## 本地运行

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

包名和可执行命令均为 `runframe`。构建后也可直接执行：

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
