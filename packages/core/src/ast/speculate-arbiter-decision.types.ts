/**
 * Normalized arbiter decision union returned by `SpeculateArbiterConfig.resolveDecision(verdict)`.
 */
export type SpeculateArbiterDecision =
  | { readonly decision: 'select-winner'; readonly winnerBranchIndex: number }
  | {
      readonly decision: 'unpark-escalation';
      readonly parkedBranchIndex: number;
      readonly rationale: string;
    }
  | { readonly decision: 'reject-all'; readonly rationale: string };
