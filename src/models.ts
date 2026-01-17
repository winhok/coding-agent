import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import "dotenv/config";

const anthropic = createAnthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL || "",
  apiKey: process.env.ANTHROPIC_API_KEY || "",
});

export const claude_opus_4_5_20251101: LanguageModel = anthropic(
  "claude-opus-4-5-20251101",
);
