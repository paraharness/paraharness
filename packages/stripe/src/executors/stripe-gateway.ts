/**
 * Pluggable runtime gateway abstraction for Stripe settlement queries and customer refund staging.
 *
 * Allows `@harness-dsl/stripe` tool executors to operate over either the official `stripe` SDK
 * (`createStripeSdkGateway`) or `defaultStripeGateway` in offline unit and integration tests.
 */
export interface StripeGateway {
  /**
   * Lists Stripe settlement records and balance transactions for a regional reconciliation account.
   *
   * Invoked by `stripe_list_settlements` tool calls after input schema validation.
   *
   * @param {object} params - Regional account and optional discrepancy identifier filter.
   *
   * @returns {Promise<unknown>} Settlement records returned by the Stripe gateway, or `undefined` in offline mode.
   */
  listSettlements(params: {
    readonly accountRegion: string;
    readonly discrepancyId?: string | undefined;
  }): Promise<unknown>;

  /**
   * Stages or issues a Stripe customer refund tied to a reconciliation journal entry.
   *
   * Invoked by `stripe_stage_refund` tool calls after pre-flight `stripe.maxRefundGuardUsd` policy evaluation.
   *
   * @param {object} params - Target Stripe charge ID, refund amount in USD, and optional journal ID.
   *
   * @returns {Promise<unknown>} Refund receipt returned by the Stripe gateway, or `undefined` in offline mode.
   */
  stageRefund(params: {
    readonly chargeId: string;
    readonly amountUsd: number;
    readonly journalId?: string | undefined;
  }): Promise<unknown>;
}
