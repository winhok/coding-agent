import fs from "node:fs";
import type { CronJobConfig, CronPauseState, RunLog } from "./types.js";

const JOBS_FILE = ".cron/jobs.json";
const LOGS_FILE = ".cron/logs.jsonl";
const STATES_FILE = ".cron/states.json";

export class CronStore {
  constructor(private baseDir: string = ".") {}

  private get jobsPath() {
    return `${this.baseDir}/${JOBS_FILE}`;
  }

  private get logsPath() {
    return `${this.baseDir}/${LOGS_FILE}`;
  }

  private get statesPath() {
    return `${this.baseDir}/${STATES_FILE}`;
  }

  init(): void {
    const dir = `${this.baseDir}/.cron`;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  loadJobs(): CronJobConfig[] {
    if (!fs.existsSync(this.jobsPath)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(this.jobsPath, "utf-8"));
      return data.jobs || [];
    } catch {
      return [];
    }
  }

  saveJobs(jobs: CronJobConfig[]): void {
    this.init();
    fs.writeFileSync(this.jobsPath, JSON.stringify({ jobs }, null, 2));
  }

  appendLog(log: RunLog): void {
    this.init();
    fs.appendFileSync(this.logsPath, `${JSON.stringify(log)}\n`);
  }

  getRecentLogs(jobId?: string, limit = 10): RunLog[] {
    if (!fs.existsSync(this.logsPath)) return [];
    const lines = fs
      .readFileSync(this.logsPath, "utf-8")
      .split("\n")
      .filter(Boolean);

    let logs: RunLog[] = lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean) as RunLog[];

    if (jobId) logs = logs.filter((log) => log.jobId === jobId);
    return logs.slice(-limit);
  }

  getPause(jobId: string): CronPauseState | undefined {
    return this.loadPauses()[jobId];
  }

  setPause(jobId: string, pause: CronPauseState): void {
    const states = this.loadPauses();
    states[jobId] = pause;
    this.savePauses(states);
  }

  clearPause(jobId: string): void {
    const states = this.loadPauses();
    if (!(jobId in states)) return;
    delete states[jobId];
    this.savePauses(states);
  }

  private loadPauses(): Record<string, CronPauseState> {
    if (!fs.existsSync(this.statesPath)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.statesPath, "utf8")) as Record<
        string,
        CronPauseState
      >;
    } catch {
      return {};
    }
  }

  private savePauses(states: Record<string, CronPauseState>): void {
    this.init();
    fs.writeFileSync(this.statesPath, JSON.stringify(states, null, 2));
  }
}
