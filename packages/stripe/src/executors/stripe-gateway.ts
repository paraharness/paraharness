/**
 * Parameters for listing regional Stripe settlement records via `StripeGateway.listSettlements`.
 *
 * Specifies the regional account identifier and optional discrepancy filter.
 */
export interface StripeListSettlementsParams {
  /** Regional account identifier (such as `'us-east'` or `'eu-west'`). */
  readonly accountRegion: string;
  /** Optional discrepancy identifier filter. */
  readonly discrepancyId?: string | undefined;
}

/**
 * Parameters for staging or issuing a customer refund via `StripeGateway.stageRefund`.
 *
 * Specifies the target Stripe charge ID, refund amount in USD, and optional reconciliation journal ID.
 */
export interface StripeStageRefundParams {
  /** Target Stripe charge identifier (`'ch_...'`). */
  readonly chargeId: string;
  /** Refund amount in USD. */
  readonly amountUsd: number;
  /** Optional NetSuite draft journal entry identifier correlated with this refund. */
  readonly journalId?: string | undefined;
}

/**
 * Pluggable runtime gateway abstraction for Stripe settlement queries and customer refund staging.
 *
 * Allows `@metaharness/stripe` tool executors to operate over either the official `stripe` SDK
 * (`createStripeSdkGateway`) or `defaultStripeGateway` in offline unit and integration tests.
 */
export interface StripeGateway {
  /**
   * Lists Stripe settlement records and balance transactions for a regional reconciliation account.
   *
   * Invoked by `stripe_list_settlements` tool calls after input schema validation.
   *
   * @param {StripeListSettlementsParams} params - Regional account and optional discrepancy identifier filter.
   *
   * @returns {Promise<unknown>} Settlement records returned by the Stripe gateway, or `undefined` in offline mode.
   */
  listSettlements(params: StripeListSettlementsParams): Promise<unknown>;

  /**
   * Stages or issues a Stripe customer refund tied to a reconciliation journal entry.
   *
   * Invoked by `stripe_stage_refund` tool calls after pre-flight `stripe.maxRefundGuardUsd` policy evaluation.
   *
   * @param {StripeStageRefundParams} params - Target Stripe charge ID, refund amount in USD, and optional journal ID.
   *
   * @returns {Promise<unknown>} Refund receipt returned by the Stripe gateway, or `undefined` in offline mode.
   */
  stageRefund(params: StripeStageRefundParams): Promise<unknown>;
}
