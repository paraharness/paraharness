/**
 * Parameter object for `admitLessonInPg`.
 *
 * Bundles the optional partition tag, preventative directive text, creation epoch,
 * and optional creator run ID.
 */
export interface AdmitLessonParams {
  /** Optional logical partition identifier. */
  readonly partition?: string;
  /** Preventative rule or architectural directive text. */
  readonly directive: string;
  /** Partition topology epoch at creation time. */
  readonly epochAtCreation: number;
  /** Optional creator run identifier. */
  readonly createdByRunId?: string;
}
