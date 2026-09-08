import { raceWithAbort } from "../security/abort.js";

type GateResult =
  | { outcome: "passed" }
  | { outcome: "blocked"; error: unknown };

/** Holds every tool effect until the run-scoped input decision is final. */
export class InputEffectGate {
  private settle!: (result: GateResult) => void;
  private readonly result = new Promise<GateResult>((resolve) => {
    this.settle = resolve;
  });
  private settled = false;

  pass(): void {
    if (this.settled) return;
    this.settled = true;
    this.settle({ outcome: "passed" });
  }

  block(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.settle({ outcome: "blocked", error });
  }

  async wait(signal: AbortSignal): Promise<void> {
    const result = await raceWithAbort(this.result, signal);
    if (result.outcome === "blocked") throw result.error;
  }
}
