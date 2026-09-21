# coding-agent

English | [简体中文](README.zh-CN.md)

A TypeScript coding agent application with model and tool execution, context and memory management, guardrails, and CLI, Feishu, scheduled task, and sub-agent entry points.

> **Maintenance status:** This repository preserves the historical coding agent application. No further development is planned here. Development and maintenance of the reusable core continue in [Knolume Runtime](https://github.com/winhok/Knolume-runtime). Start there for new runtime integrations.

## Relationship to Knolume Runtime

This repository combines the runtime and application wiring in one package: `src/main.ts` connects models, tools, configuration, and application entry points, while `src/index.ts` starts the CLI. Knolume Runtime extracts and develops the reusable capabilities as the separate `@knolume/runtime` library for host applications to compose.

| Capability | Historical implementation here | Knolume Runtime counterpart |
| --- | --- | --- |
| Agent loop, retries, loop detection, and events | `src/agent/` | `src/harness/agent/`, using the `AgentToolRuntime` interface for tools |
| Tool registration, execution, permissions, and approvals | `src/tools/`, `src/security/` | `src/tools/`; the host supplies tool implementations and permission policies |
| Context, memory, retrieval, and sessions | `src/context/`, `src/memory/`, `src/rag/`, `src/session/` | Corresponding modules under `src/harness/` |
| Skills, sub-agents, traces, and usage | `src/skills/`, `src/agents/`, `src/trace/`, `src/usage/` | Corresponding modules under `src/harness/` |
| Guardrails | Application policies and execution logic in `src/guardrails/` | Reusable guardrail execution interfaces; the host supplies rules, identity context, and checker models |
| Application entry points and transport | CLI, Feishu, Cron, and built-in file, shell, and Git tools | A library and protocol definitions in `src/protocol/`; the host implements entry points, HTTP/SSE services, and product tools |

This is an extraction and continued development of core capabilities, **not** a drop-in migration: APIs, configuration, and persisted data formats are not assumed to be compatible. This repository retains its original implementation and does not depend on `@knolume/runtime`. The library does not include this application's CLI, Feishu, or Cron entry points.

For new applications, see the [Knolume Runtime integration guide](https://github.com/winhok/Knolume-runtime#use-in-an-application) and [runnable example](https://github.com/winhok/Knolume-runtime/tree/main/examples). Existing applications need to adapt their models, prompts, tools, permissions, and approvals to the library API, and check session, memory, and configuration compatibility separately.

## What this repository preserves

| Capability | Implementation |
| --- | --- |
| Model loop: model calls, tool-call loop, retries, and loop detection | `src/agent/`, `src/models.ts` |
| Tool execution and permission control | `src/tools/`, `src/security/` |
| MCP connections to external tool servers | `src/tools/mcp-client.ts` |
| Prompt assembly, context compression, and project rules | `src/context/` |
| Memory storage, retrieval, and validation | `src/memory/` |
| Input, tool-argument, and final-output guardrails; semantic checks, redaction, audit, owner approval, and execution gating | `src/guardrails/` |
| Trace recording and inspection | `src/trace/` |
| Session persistence and recovery | `src/session/` |
| Guardrail baseline evaluation and real-model smoke evaluation | `evals/` |

## Application entry points

The coding agent combines these capabilities with file operations, code search, terminal execution, and sub-agents. It supports interactive chat, one-off tasks, and read-only planning. Application wiring lives in `src/main.ts`; the CLI starts in `src/index.ts`. The runtime and reference application remain in the same package here.

## Run the historical application locally

Install Node.js and the pnpm version specified in `package.json`, then run:

```sh
pnpm install
pnpm run init
pnpm start
```

The setup wizard creates a configuration file and prompts for model credentials. For compatibility with existing installations, the filename remains `super-agent.config.json`; session and memory paths continue to follow the existing configuration.

```sh
pnpm start --help
pnpm start ask "Explain the structure of this project"
pnpm start plan "Analyze how to add a tool"
pnpm start --continue
```

The package and executable are named `coding-agent`. You can also build and run the CLI directly:

```sh
pnpm build
node dist/index.js --help
```

By default, `ask` and `plan` expose only read-only tools; `plan` always remains read-only. Interactive mode asks for approval by default. `--approval-mode always` automatically approves sensitive operations.

## Verification

```sh
pnpm typecheck
pnpm test
pnpm eval
```

`pnpm eval:smoke` separately runs a real-model evaluation. It requires valid model configuration and calls an external model service. Offline tests and evaluations do not establish acceptance with real models or external systems such as Feishu.
