export interface ShutdownTask {
  name: string;
  close: () => void | Promise<void>;
}

export interface RuntimeShutdown {
  readonly started: boolean;
  run(): Promise<void>;
}

/** Runs resource cleanup once, in order, without one failure skipping the rest. */
export function createRuntimeShutdown(
  tasks: readonly ShutdownTask[],
  onFailure: (task: string, error: unknown) => void,
): RuntimeShutdown {
  let shutdownPromise: Promise<void> | undefined;
  return {
    get started() {
      return shutdownPromise !== undefined;
    },
    run() {
      shutdownPromise ??= (async () => {
        for (const task of tasks) {
          try {
            await task.close();
          } catch (error) {
            onFailure(task.name, error);
          }
        }
      })();
      return shutdownPromise;
    },
  };
}
