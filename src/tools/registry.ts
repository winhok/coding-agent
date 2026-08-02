import { jsonSchema, type Schema } from "ai";
import type { JSONSchema7 } from "json-schema";

type ToolExecute = {
  bivarianceHack(input: unknown): Promise<unknown>;
}["bivarianceHack"];

type AISDKTool = {
  description: string;
  inputSchema: Schema<unknown>;
  execute(input: unknown): Promise<string>;
};

type AISDKToolSet = Record<string, AISDKTool>;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  isConcurrencySafe?: boolean;
  isReadOnly?: boolean;
  maxResultChars?: number;
  shouldDefer?: boolean; // 是否延迟加载
  searchHint?: string; // 搜索提示词，帮助 ToolSearch 匹配
  execute: ToolExecute;
}

interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPToolClient {
  connect(): Promise<void>;
  listTools(): Promise<MCPTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

const DEFAULT_MAX_RESULT_CHARS = 3000;

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  // 三个状态变量构成一把读写锁
  private exclusiveLock = false; // 当前是否有独占锁持有者
  private concurrentCount = 0; // 当前共享锁持有数
  private waitQueue: Array<() => void> = []; // 阻塞等待中的 resolve 函数

  register(...tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  private mcpClients: MCPToolClient[] = [];

  async registerMCPServer(
    serverName: string,
    client: MCPToolClient,
  ): Promise<string[]> {
    let connected = false;
    try {
      await client.connect();
      connected = true;

      const tools = await client.listTools();
      const registered: string[] = [];

      for (const tool of tools) {
        const prefixedName = `mcp__${serverName}__${tool.name}`;
        if (this.tools.has(prefixedName)) continue;

        const toolClient = client;
        const originalName = tool.name;

        this.register({
          name: prefixedName,
          description: `[MCP:${serverName}] ${tool.description}`,
          parameters: tool.inputSchema,
          isConcurrencySafe: false,
          isReadOnly: false,
          maxResultChars: DEFAULT_MAX_RESULT_CHARS,
          shouldDefer: true,
          searchHint: `${serverName} ${tool.name} ${tool.description}`,
          execute: async (input) =>
            toolClient.callTool(originalName, input as Record<string, unknown>),
        });

        registered.push(prefixedName);
      }

      this.mcpClients.push(client);
      return registered;
    } catch (error) {
      if (connected) {
        await client.close().catch(() => {});
      }
      throw error;
    }
  }

  async closeAllMCP(): Promise<void> {
    for (const client of this.mcpClients) {
      await client.close();
    }
    this.mcpClients = [];
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  // 获取共享锁：只要没人独占就能拿，多个只读工具可以同时持有
  private async acquireConcurrent(): Promise<void> {
    while (this.exclusiveLock) {
      await new Promise<void>((r) => this.waitQueue.push(r));
    }
    this.concurrentCount++;
  }

  private releaseConcurrent(): void {
    this.concurrentCount--;
    if (this.concurrentCount === 0) this.drainQueue();
  }

  // 获取独占锁：必须等所有共享锁释放、且没人持独占
  private async acquireExclusive(): Promise<void> {
    while (this.exclusiveLock || this.concurrentCount > 0) {
      await new Promise<void>((r) => this.waitQueue.push(r));
    }
    this.exclusiveLock = true;
  }

  private releaseExclusive(): void {
    this.exclusiveLock = false;
    this.drainQueue();
  }

  // 锁释放时把等待队列全唤醒，让它们重新去抢锁
  private drainQueue(): void {
    const waiting = this.waitQueue.splice(0);
    for (const resolve of waiting) resolve();
  }

  toAISDKFormat(): AISDKToolSet {
    const result: AISDKToolSet = {};
    for (const [name, tool] of this.tools) {
      const maxChars = tool.maxResultChars;
      const executeFn = tool.execute;
      const isSafe = tool.isConcurrencySafe === true;

      result[name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters as JSONSchema7),
        execute: async (input: unknown) => {
          // 在真正执行前先按 isConcurrencySafe 获取锁
          if (isSafe) {
            await this.acquireConcurrent();
            console.log(`  [并发] ${name} 获取共享锁`);
          } else {
            await this.acquireExclusive();
            console.log(`  [串行] ${name} 获取独占锁，等待其他工具完成`);
          }
          try {
            const raw = await executeFn(input);
            const text =
              typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
            return truncateResult(text, maxChars);
          } finally {
            // 不管成功还是抛异常，锁都要释放
            if (isSafe) {
              this.releaseConcurrent();
            } else {
              this.releaseExclusive();
            }
          }
        },
      };
    }
    return result;
  }
}

export function truncateResult(
  text: string,
  maxChars: number = DEFAULT_MAX_RESULT_CHARS,
): string {
  if (text.length <= maxChars) return text;
  const headSize = Math.floor(maxChars * 0.6);
  const tailSize = maxChars - headSize;
  const head = text.slice(0, headSize);
  const tail = text.slice(-tailSize);
  const dropped = text.length - headSize - tailSize;

  return `${head}\n\n... 省略 ${dropped} 字符...\n\n${tail}`;
}
