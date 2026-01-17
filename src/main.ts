import { createInterface } from "node:readline/promises";

import type { ModelMessage } from "ai";

import { agent } from "./agent.ts";

const history: ModelMessage[] = [];

const rl = createInterface(process.stdin, process.stdout);

while (true) {
  const ask = await rl.question("Ask:");
  if (!ask.trim()) break;

  const userMessage: ModelMessage = { role: "user", content: ask };

  const { text } = await agent.generate({
    messages: [...history, userMessage],
  });

  history.push(userMessage);

  const assistantMessage: ModelMessage = { role: "assistant", content: text };

  history.push(assistantMessage);
  console.log(`Assistant: ${text}`);
}
rl.close();
