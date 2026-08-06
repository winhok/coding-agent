import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface MemoryEntry {
  name: string;
  description: string;
  type: "user" | "feedback" | "project" | "reference";
  content: string;
  filePath: string;
}

const MEMORY_DIR = ".memory";
const INDEX_FILE = "MEMORY.md";
const MAX_INDEX_LINES = 200;
const MAX_FILE_CHARS = 4000;

export class MemoryStore {
  private readonly baseDir: string;

  constructor(baseDir: string = ".") {
    this.baseDir = baseDir;
  }

  private get memoryDir(): string {
    return path.join(this.baseDir, MEMORY_DIR);
  }

  private get indexPath(): string {
    return this.resolveMemoryPath(INDEX_FILE, true);
  }

  init(): void {
    if (!fs.existsSync(this.memoryDir)) {
      fs.mkdirSync(this.memoryDir, { recursive: true });
    }
    if (!fs.existsSync(this.indexPath)) {
      fs.writeFileSync(this.indexPath, "# Memory Index\n", "utf-8");
    }
  }

  save(entry: Omit<MemoryEntry, "filePath">): string {
    this.init();
    const slug = entry.name
      .toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, "-")
      .replace(/^-|-$/g, "");
    const existing = this.list().find(
      (candidate) =>
        candidate.type === entry.type && candidate.name === entry.name,
    );
    const filename = existing
      ? path.basename(existing.filePath)
      : this.createFilename(entry.type, entry.name, slug);
    const filePath = this.resolveMemoryPath(filename);

    if (!existing && fs.existsSync(filePath)) {
      throw new Error(`记忆文件名冲突: ${filename}`);
    }

    const fileContent = [
      "---",
      `name: ${entry.name}`,
      `description: ${entry.description}`,
      `type: ${entry.type}`,
      "---",
      "",
      entry.content,
    ].join("\n");

    fs.writeFileSync(filePath, fileContent, "utf-8");
    this.updateIndex(entry.name, filename, entry.description);
    return filename;
  }

  private updateIndex(
    name: string,
    filename: string,
    description: string,
  ): void {
    const indexContent = fs.readFileSync(this.indexPath, "utf-8");
    const lines = indexContent.split("\n");

    const existingIdx = lines.findIndex((l) => l.includes(`(${filename})`));
    const newLine = `- [${name}](${filename}) — ${description}`;

    if (existingIdx >= 0) {
      lines[existingIdx] = newLine;
    } else {
      if (lines.length >= MAX_INDEX_LINES) {
        console.log(
          `[memory] 索引已达 ${MAX_INDEX_LINES} 行上限，移除最早的条目`,
        );
        const firstEntry = lines.findIndex((l) => l.startsWith("- "));
        if (firstEntry >= 0) lines.splice(firstEntry, 1);
      }
      lines.push(newLine);
    }

    fs.writeFileSync(this.indexPath, lines.join("\n"), "utf-8");
  }

  list(): MemoryEntry[] {
    this.init();
    const entries: MemoryEntry[] = [];
    const files = fs
      .readdirSync(this.memoryDir)
      .filter((f) => f.endsWith(".md") && f !== INDEX_FILE);

    for (const file of files) {
      let filePath: string;
      try {
        filePath = this.resolveMemoryPath(file);
      } catch {
        continue;
      }
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = this.parseFrontmatter(raw);
      if (parsed) {
        entries.push({ ...parsed, filePath });
      }
    }
    return entries;
  }

  search(query: string): MemoryEntry[] {
    const all = this.list();
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return [];
    const keywords = normalizedQuery.split(/\s+/);
    return all.filter((entry) => {
      const text =
        `${entry.name} ${entry.description} ${entry.content}`.toLowerCase();
      return keywords.some((kw) => text.includes(kw));
    });
  }

  loadIndex(): string {
    this.init();
    const raw = fs.readFileSync(this.indexPath, "utf-8");
    return raw.length > MAX_FILE_CHARS
      ? `${raw.slice(0, MAX_FILE_CHARS)}\n...(已截断)`
      : raw;
  }

  loadFile(filename: string): string | null {
    const filePath = this.resolveMemoryPath(filename);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    return raw.length > MAX_FILE_CHARS
      ? `${raw.slice(0, MAX_FILE_CHARS)}\n...(已截断)`
      : raw;
  }

  delete(filename: string): boolean {
    const filePath = this.resolveMemoryPath(filename);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);

    const indexContent = fs.readFileSync(this.indexPath, "utf-8");
    const lines = indexContent
      .split("\n")
      .filter((l) => !l.includes(`(${filename})`));
    fs.writeFileSync(this.indexPath, lines.join("\n"), "utf-8");
    return true;
  }

  buildPromptSection(): string {
    this.init();
    const index = this.loadIndex();
    const entries = this.list();

    if (entries.length === 0) {
      return "[记忆系统] 当前没有存储任何记忆。你可以使用 memory 工具来保存重要信息。";
    }

    const lines = [
      `[记忆系统] 共 ${entries.length} 条记忆`,
      "",
      "记忆索引：",
      index,
      "",
      "使用 memory 工具的 read 操作来读取具体记忆内容。",
      "记忆是线索，不是事实——使用前先验证其准确性。",
    ];
    return lines.join("\n");
  }

  private parseFrontmatter(raw: string): Omit<MemoryEntry, "filePath"> | null {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return null;
    const frontmatter = match[1];
    const content = match[2];
    if (frontmatter === undefined || content === undefined) return null;

    const meta: Record<string, string> = {};
    for (const line of frontmatter.split("\n")) {
      const idx = line.indexOf(":");
      if (idx > 0) {
        meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }

    const validTypes = ["user", "feedback", "project", "reference"];
    if (!meta.name || !meta.type || !validTypes.includes(meta.type))
      return null;

    return {
      name: meta.name,
      description: meta.description || "",
      type: meta.type as MemoryEntry["type"],
      content: content.trim(),
    };
  }

  private createFilename(
    type: MemoryEntry["type"],
    name: string,
    slug: string,
  ): string {
    const hash = createHash("sha256")
      .update(`${type}\0${name}`)
      .digest("hex")
      .slice(0, 12);
    return `${type}_${slug || "memory"}-${hash}.md`;
  }

  private resolveMemoryPath(filename: string, allowIndex = false): string {
    if (
      !filename ||
      path.isAbsolute(filename) ||
      path.basename(filename) !== filename ||
      filename.includes("\\") ||
      !filename.endsWith(".md") ||
      (!allowIndex && filename === INDEX_FILE)
    ) {
      throw new Error(`非法记忆文件名: ${filename}`);
    }

    const memoryRoot = path.resolve(this.memoryDir);
    const filePath = path.resolve(memoryRoot, filename);
    this.assertWithinMemory(memoryRoot, filePath, filename);

    if (fs.existsSync(filePath)) {
      const realRoot = fs.realpathSync(memoryRoot);
      const realFilePath = fs.realpathSync(filePath);
      this.assertWithinMemory(realRoot, realFilePath, filename);
    }

    return filePath;
  }

  private assertWithinMemory(
    memoryRoot: string,
    filePath: string,
    filename: string,
  ): void {
    const relativePath = path.relative(memoryRoot, filePath);
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      throw new Error(`记忆文件不能位于 .memory 目录之外: ${filename}`);
    }
  }
}
