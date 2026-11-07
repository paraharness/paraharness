/**
 * Minimal structural subset of the official `Stripe` SDK client used by `createStripeSdkGateway`.
 *
 * Matches `Stripe.balanceTransactions.list` and `Stripe.refunds.create` on `new Stripe(apiKey)` instances
 * while allowing deterministic fake SDK clients in offline unit tests.
 */
export interface StripeSdkClientLike {
  /** Stripe balance transactions resource namespace. */
  readonly balanceTransactions: {
    /**
     * Lists balance transactions from the Stripe API.
     *
     * Queries recent settlement transactions up to `params.limit`.
     *
     * @param {object} params - Pagination limit parameter.
     *
     * @returns {Promise<{ readonly data: readonly unknown[] }>} Balance transaction list response.
     */
    list(params: { limit: number }): Promise<{ readonly data: readonly unknown[] }>;
  };

  /** Stripe refunds resource namespace. */
  readonly refunds: {
    /**
     * Creates a new refund against a Stripe charge.
     *
     * Issues a refund for `params.amount` (in USD cents) with reconciliation `metadata`.
     *
     * @param {object} params - Target charge ID, amount in cents, and metadata.
     *
     * @returns {Promise<unknown>} Created Stripe refund object.
     */
    create(params: {
      charge: string;
      amount: number;
      metadata: Record<string, string>;
    }): Promise<unknown>;
  };
}
