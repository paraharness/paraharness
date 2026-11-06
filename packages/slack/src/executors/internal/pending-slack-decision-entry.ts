import type { z } from '@harness-dsl/core';

/**
 * In-flight interactive decision state tracked by `SlackApproverAdapter`.
 *
 * Stores the Slack message timestamp, response validation schema, resolution/rejection
 * callbacks, and optional heartbeat timer so `submitDecision` and `cancelDecision` can settle it.
 */
export interface PendingSlackDecisionEntry {
  /** Enclosing harness run identifier. */
  readonly runId: string;
  /** Decision request identifier. */
  readonly requestId: string;
  /** Resolved Slack bot token used to post the decision prompt. */
  readonly botToken: string;
  /** Resolved Slack channel ID where the prompt was posted. */
  readonly channel: string;
  /** Slack message timestamp (`ts`) of the posted decision block. */
  readonly messageTs: string;
  /** Zod schema validating the human's decision response. */
  readonly responseSchema: z.ZodTypeAny;
  /** Optional periodic keep-alive heartbeat interval handle. */
  readonly heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  /** Promise resolver accepting the schema-validated response. */
  readonly resolve: (value: unknown) => void;
  /** Promise rejecter invoked on cancellation or abort. */
  readonly reject: (reason: Error) => void;
}
