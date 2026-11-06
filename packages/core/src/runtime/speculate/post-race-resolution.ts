/**
 * Post-race classification computed by `resolvePostRaceCases()` (`SPEC.md` §3.7.2 Capability 2).
 *
 * Distinguishes Case 1 (`'all-failed'`), Case 2 (`'unpark-sole-escalated'`), Case 3 (`'sole-survivor'`),
 * and Case 4 (`'contested-arbitration'`).
 */
export interface PostRaceResolution {
  /** Post-race case discriminant. */
  readonly caseKind:
    | 'all-failed'
    | 'unpark-sole-escalated'
    | 'sole-survivor'
    | 'contested-arbitration';
  /** Target branch index for Case 2 (`'unpark-sole-escalated'`) or Case 3 (`'sole-survivor'`). */
  readonly targetBranchIndex?: number;
}
