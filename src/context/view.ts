import type { ModelMessage } from "ai";
import type { UsageTracker } from "../usage/tracker.js";

export interface ContextSlice {
  name: string;
  tokens: number;
  color: number;
  icon: string;
}

export interface ContextSnapshot {
  modelName: string;
  modelId: string;
  windowTokens: number;
  usedTokens: number;
  slices: ContextSlice[];
  autocompactBufferTokens: number;
}

const COLORS = {
  system: 63,
  tools: 99,
  memory: 220,
  skills: 36,
  messages: 111,
  free: 240,
  buffer: 244,
  text: 255,
  dim: 244,
};

function fg(code: number, text: string): string {
  return `\x1b[38;5;${code}m${text}\x1b[0m`;
}

function pct(value: number, total: number): string {
  if (total === 0) return "0.0%";
  return `${((value / total) * 100).toFixed(1)}%`;
}

function fmtTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function fmtLocalTimestamp(date: Date): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timestamp = new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return `${timestamp} ${timeZone}`;
}

export function renderContextMatrix(snapshot: ContextSnapshot): string {
  const { windowTokens, slices, autocompactBufferTokens } = snapshot;
  const TOTAL_CELLS = 256;
  const tokensPerCell = windowTokens / TOTAL_CELLS;
  const cells: number[] = [];

  for (const slice of slices) {
    if (slice.tokens <= 0) continue;
    const sliceCells = Math.max(1, Math.round(slice.tokens / tokensPerCell));
    for (
      let index = 0;
      index < sliceCells && cells.length < TOTAL_CELLS;
      index++
    ) {
      cells.push(slice.color);
    }
  }

  const bufferCells = Math.max(
    0,
    Math.round(autocompactBufferTokens / tokensPerCell),
  );
  const freeCells = Math.max(0, TOTAL_CELLS - cells.length - bufferCells);
  for (let index = 0; index < freeCells; index++) cells.push(-1);
  for (
    let index = 0;
    index < bufferCells && cells.length < TOTAL_CELLS;
    index++
  ) {
    cells.push(-2);
  }

  const lines: string[] = [];
  for (let row = 0; row < 16; row++) {
    const rowCells: string[] = [];
    for (let column = 0; column < 16; column++) {
      const color = cells[row * 16 + column];
      if (color === -1) rowCells.push(fg(COLORS.free, "○"));
      else if (color === -2) rowCells.push(fg(COLORS.buffer, "▢"));
      else rowCells.push(fg(color ?? COLORS.free, "●"));
    }
    lines.push(rowCells.join(" "));
  }
  return lines.join("\n");
}

export function renderContextLegend(snapshot: ContextSnapshot): string {
  const { slices, autocompactBufferTokens, windowTokens, usedTokens } =
    snapshot;
  const lines: string[] = [];

  lines.push(`\x1b[1m${fg(COLORS.text, snapshot.modelName)}\x1b[0m`);
  lines.push(fg(COLORS.dim, snapshot.modelId));
  lines.push(
    `${fmtTokens(usedTokens)}/${fmtTokens(windowTokens)} tokens (${pct(usedTokens, windowTokens)})`,
  );
  lines.push("");
  lines.push(fg(COLORS.dim, "\x1b[3mEstimated usage by category\x1b[0m"));
  for (const slice of slices) {
    if (slice.tokens <= 0) continue;
    const dot = fg(slice.color, "●");
    const label = `${slice.icon} ${slice.name}`;
    const value = `${fmtTokens(slice.tokens)} tokens (${pct(slice.tokens, windowTokens)})`;
    lines.push(`${dot} ${label}: ${value}`);
  }

  const free = Math.max(0, windowTokens - usedTokens - autocompactBufferTokens);
  lines.push(
    `${fg(COLORS.free, "○")}  Free space: ${fmtTokens(free)} (${pct(free, windowTokens)})`,
  );
  lines.push(
    `${fg(COLORS.buffer, "▢")}  Autocompact buffer: ${fmtTokens(autocompactBufferTokens)} (${pct(autocompactBufferTokens, windowTokens)})`,
  );
  return lines.join("\n");
}

export function renderContextView(snapshot: ContextSnapshot): string {
  const matrix = renderContextMatrix(snapshot).split("\n");
  const legend = renderContextLegend(snapshot).split("\n");
  const rows = Math.max(matrix.length, legend.length);
  const output: string[] = [];
  for (let index = 0; index < rows; index++) {
    const left = (matrix[index] ?? "").padEnd(80, " ");
    output.push(`  ${left}  ${legend[index] ?? ""}`);
  }
  return `\n${output.join("\n")}\n`;
}

export interface BuildSnapshotInput {
  modelName: string;
  modelId: string;
  windowTokens: number;
  systemPromptChars: number;
  toolDescriptionChars: number;
  memoryChars: number;
  skillsChars: number;
  messages: ModelMessage[];
  autocompactBufferTokens?: number;
}

const CHARS_PER_TOKEN = 3.5;

function approxTokensFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function approxMessageTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    if (typeof message.content === "string") {
      chars += message.content.length;
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const rawPart of message.content) {
      if (!rawPart || typeof rawPart !== "object") continue;
      const part = rawPart as unknown as Record<string, unknown>;
      if (part.type === "text" && typeof part.text === "string") {
        chars += part.text.length;
      } else if (part.type === "tool-call") {
        chars += JSON.stringify(part.input ?? {}).length + 80;
      } else if (part.type === "tool-result") {
        const output = part.output;
        if (typeof output === "string") chars += output.length;
        else if (output && typeof output === "object" && "value" in output) {
          chars += String(output.value).length;
        } else chars += JSON.stringify(output ?? {}).length;
        chars += 80;
      }
    }
  }
  return approxTokensFromChars(chars);
}

export function buildContextSnapshot(
  input: BuildSnapshotInput,
): ContextSnapshot {
  const slices: ContextSlice[] = [
    {
      name: "System prompt",
      tokens: approxTokensFromChars(input.systemPromptChars),
      color: COLORS.system,
      icon: "◆",
    },
    {
      name: "System tools",
      tokens: approxTokensFromChars(input.toolDescriptionChars),
      color: COLORS.tools,
      icon: "◇",
    },
    {
      name: "Memory",
      tokens: approxTokensFromChars(input.memoryChars),
      color: COLORS.memory,
      icon: "◈",
    },
    {
      name: "Skills",
      tokens: approxTokensFromChars(input.skillsChars),
      color: COLORS.skills,
      icon: "◉",
    },
    {
      name: "Messages",
      tokens: approxMessageTokens(input.messages),
      color: COLORS.messages,
      icon: "◎",
    },
  ];
  const usedTokens = slices.reduce((total, slice) => total + slice.tokens, 0);
  return {
    modelName: input.modelName,
    modelId: input.modelId,
    windowTokens: input.windowTokens,
    usedTokens,
    slices,
    autocompactBufferTokens:
      input.autocompactBufferTokens ?? Math.round(input.windowTokens * 0.05),
  };
}

export function renderUsageView(tracker: UsageTracker): string {
  const totals = tracker.totals();
  const lines: string[] = [];
  const color = (code: number, text: string) => fg(code, text);
  const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;
  const currency = totals.currency === "CNY" ? "¥" : "$";
  const totalCacheable =
    totals.cacheReadTokens + totals.cacheWriteTokens + totals.inputTokens;

  lines.push(bold(color(255, "  Usage Summary")));
  lines.push(
    color(244, `  ${totals.steps} 步累计 · ${fmtLocalTimestamp(new Date())}`),
  );
  lines.push("");
  lines.push(
    `  ${color(111, "◎")} Input          ${fmtTokens(totals.inputTokens).padStart(8)} tokens`,
  );
  lines.push(
    `  ${color(220, "◈")} Cache write    ${fmtTokens(totals.cacheWriteTokens).padStart(8)} tokens`,
  );
  lines.push(
    `  ${color(36, "◉")} Cache read     ${fmtTokens(totals.cacheReadTokens).padStart(8)} tokens   (${(totals.hitRate * 100).toFixed(1)}% hit)`,
  );
  lines.push(
    `  ${color(99, "◇")} Output         ${fmtTokens(totals.outputTokens).padStart(8)} tokens`,
  );
  lines.push("");

  const barWidth = 30;
  const filled = Math.round(totals.hitRate * barWidth);
  const bar =
    color(36, "█".repeat(filled)) + color(240, "░".repeat(barWidth - filled));
  lines.push(`  Cache hit rate  ${bar}  ${(totals.hitRate * 100).toFixed(1)}%`);
  lines.push("");
  lines.push(
    `  ${bold("Cost")}            ${color(220, `${currency}${totals.cost.toFixed(4)}`)}`,
  );
  lines.push(
    `  ${color(244, "Without cache")}   ${color(244, `${currency}${totals.baselineCost.toFixed(4)}`)}`,
  );
  const savedPercent =
    totals.baselineCost > 0
      ? (totals.savedCost / totals.baselineCost) * 100
      : 0;
  if (totals.savedCost > 0) {
    lines.push(
      `  ${bold(color(36, "Saved"))}           ${color(36, `${currency}${totals.savedCost.toFixed(4)}`)} (${savedPercent.toFixed(1)}% off)`,
    );
  }
  if (totalCacheable === 0) {
    lines.push(`  ${color(244, "尚无可缓存的 input，多聊几轮再看 :)")}`);
  }
  return `\n${lines.join("\n")}\n`;
}
