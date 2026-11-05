import type { HarnessRuntimeController } from '../ports.js';
import type { FlowDef, HarnessDef } from '../ast.js';

export interface CreateHarnessRuntimeOptions {
  readonly hostRootDir?: string;
}

export interface HarnessRuntime extends HarnessRuntimeController {
  start(): Promise<void>;
  stop(): Promise<void>;
  enqueueToLane<TIn>(
    laneId: string,
    item: TIn,
    opts?: { readonly priorityBoost?: number; readonly parentRunId?: string },
  ): Promise<string>;
  runFlowOnce<TIn, TOut = unknown>(
    flow: FlowDef<TIn, any, any, any, any>,
    input: TIn,
    opts?: { readonly runId?: string; readonly itemKey?: string },
  ): Promise<{
    readonly runId: string;
    readonly status: string;
    readonly output?: TOut;
  }>;
  recoverInterruptedRunsOnBoot(): Promise<void>;
}

export function createHarnessRuntime(
  _harness: HarnessDef,
  _opts?: CreateHarnessRuntimeOptions,
): HarnessRuntime {
  throw new Error('HarnessRuntime is implemented in M2 (@harness-dsl/core/runtime).');
}
