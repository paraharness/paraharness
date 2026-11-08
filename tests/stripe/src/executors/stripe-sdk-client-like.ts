/**
 * Parameters for listing Stripe balance transactions via `StripeBalanceTransactionsResource.list`.
 *
 * Specifies the maximum number of balance transaction records to return.
 */
export interface StripeBalanceTransactionListParams {
  /** Maximum number of balance transactions to retrieve. */
  readonly limit: number;
}

/**
 * Response shape returned by `StripeBalanceTransactionsResource.list`.
 *
 * Wraps the page of balance transaction records inside `data`.
 */
export interface StripeBalanceTransactionListResponse {
  /** Array of Stripe balance transaction objects. */
  readonly data: readonly unknown[];
}

/**
 * Structural contract for the Stripe SDK `balanceTransactions` resource namespace.
 *
 * Exposes `.list(params)` for querying settlement transactions.
 */
export interface StripeBalanceTransactionsResource {
  /**
   * Lists balance transactions from the Stripe API.
   *
   * Queries recent settlement transactions up to `params.limit`.
   *
   * @param {StripeBalanceTransactionListParams} params - Pagination limit parameter.
   *
   * @returns {Promise<StripeBalanceTransactionListResponse>} Balance transaction list response.
   */
  list(
    params: StripeBalanceTransactionListParams,
  ): Promise<StripeBalanceTransactionListResponse>;
}

/**
 * Parameters for creating a Stripe refund via `StripeRefundsResource.create`.
 *
 * Specifies the target charge ID, refund amount in USD cents, and string metadata map.
 */
export interface StripeRefundCreateParams {
  /** Target Stripe charge identifier (`'ch_...'`). */
  readonly charge: string;
  /** Refund amount in integer USD cents. */
  readonly amount: number;
  /** String key-value metadata attached to the refund. */
  readonly metadata: Record<string, string>;
}

/**
 * Structural contract for the Stripe SDK `refunds` resource namespace.
 *
 * Exposes `.create(params)` for issuing customer refunds.
 */
export interface StripeRefundsResource {
  /**
   * Creates a new refund against a Stripe charge.
   *
   * Issues a refund for `params.amount` (in USD cents) with reconciliation `metadata`.
   *
   * @param {StripeRefundCreateParams} params - Target charge ID, amount in cents, and metadata.
   *
   * @returns {Promise<unknown>} Created Stripe refund object.
   */
  create(params: StripeRefundCreateParams): Promise<unknown>;
}

/**
 * Minimal structural subset of the official `Stripe` SDK client used by `createStripeSdkGateway`.
 *
 * Matches `Stripe.balanceTransactions.list` and `Stripe.refunds.create` on `new Stripe(apiKey)` instances
 * while allowing deterministic fake SDK clients in offline unit tests.
 */
export interface StripeSdkClientLike {
  /** Stripe balance transactions resource namespace. */
  readonly balanceTransactions: StripeBalanceTransactionsResource;
  /** Stripe refunds resource namespace. */
  readonly refunds: StripeRefundsResource;
}
