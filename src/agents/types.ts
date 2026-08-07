export interface SubAgentConfig {
  maxSpawnDepth: number;
  maxConcurrent: number;
  defaultTimeout: number;
}

export const DEFAULT_CONFIG: SubAgentConfig = {
  maxSpawnDepth: 1,
  maxConcurrent: 3,
  defaultTimeout: 60_000,
};

export interface SpawnRequest {
  task: string;
  tools?: string[];
  timeout?: number;
}

export interface SubAgentRun {
  id: string;
  task: string;
  status: "running" | "completed" | "error" | "timeout";
  depth: number;
  startedAt: string;
  finishedAt?: string;
  result?: string;
  error?: string;
}
