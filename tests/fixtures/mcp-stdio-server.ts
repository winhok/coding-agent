import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "coding-agent-test-mcp-server",
  version: "1.0.0",
});

server.registerTool(
  "echo_owner",
  {
    description: "Echo owner through a real stdio MCP server",
    inputSchema: { owner: z.string() },
  },
  async ({ owner }) => ({
    content: [
      {
        type: "text",
        text: `owner=${owner}; marker=${process.env.MCP_TEST_MARKER ?? ""}`,
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
