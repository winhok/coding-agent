import { agent } from "./agent.ts";

const result = await agent.generate({ prompt: "What is the current time?" });

console.log(result);
