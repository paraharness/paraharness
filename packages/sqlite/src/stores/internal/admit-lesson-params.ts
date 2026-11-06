/**
 * Parameter object for `admitLessonInSqlite`.
 *
 * Bundles the optional partition tag, directive text, creation epoch, and optional creator run ID.
 */
export interface AdmitLessonParams {
  /** Optional logical partition identifier associated with the lesson. */
  readonly partition?: string;
  /** Preventative rule or architectural directive text. */
  readonly directive: string;
  /** Partition topology epoch at creation. */
  readonly epochAtCreation: number;
  /** Optional creator run identifier (`lastMutatedByRunId ?? runId`). */
  readonly createdByRunId?: string;
}
