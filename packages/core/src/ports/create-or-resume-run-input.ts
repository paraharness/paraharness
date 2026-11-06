export type { CreateOrResumeRunRequest } from './create-or-resume-run-request.js';

/**
 * Input record passed to `LedgerStore.createOrResumeRun()`.
 *
 * Supplies the run and lane identifiers, deduplication item key, serialized flow input,
 * pinned wire prefixes, and initial cost/budget limits when starting or resuming a run.
 */
export interface CreateOrResumeRunInput {
  /** Unique identifier of the flow run. */
  readonly runId: string;
  /** Identifier of the enclosing `LaneNode`. */
  readonly laneId: string;
  /** Deduplication key extracted via `LaneNode.keyMapper(input)`. */
  readonly itemKey: string;
  /** JSON-serialized validated flow input payload. */
  readonly inputJson: string;
  /** Optional map of `prefixGroupId` to JSON-serialized `CompiledWirePrefix` pinned at run start. */
  readonly compiledPrefixesJson?: Readonly<Record<string, string>>;
  /** Optional initial cumulative USD cost. */
  readonly costUsd?: number;
  /** Optional human-approved maximum USD budget ceiling. */
  readonly approvedMaxCostUsd?: number;
}
