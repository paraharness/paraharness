import Stripe from 'stripe';
import type { StripeGateway } from './stripe-gateway.js';
import type { StripeSdkClientLike } from './stripe-sdk-client-like.js';

/**
 * Creates a `StripeGateway` backed by the official `stripe` SDK (`new Stripe(apiKey)`).
 *
 * Accepts either a raw Stripe secret API key string or a pre-configured `Stripe` / `StripeSdkClientLike`
 * instance, translating `amountUsd` into integer USD cents (`Math.round(amountUsd * 100)`).
 *
 * @param {string | StripeSdkClientLike} apiKeyOrClient - Stripe API key string or `Stripe` SDK client instance.
 *
 * @returns {StripeGateway} Frozen `StripeGateway` delegating to the official `stripe` SDK.
 */
export function createStripeSdkGateway(
  apiKeyOrClient: string | StripeSdkClientLike,
): StripeGateway {
  const client: StripeSdkClientLike =
    typeof apiKeyOrClient === 'string' ? new Stripe(apiKeyOrClient) : apiKeyOrClient;

  return Object.freeze<StripeGateway>({
    async listSettlements(params: {
      readonly accountRegion: string;
      readonly discrepancyId?: string | undefined;
    }): Promise<unknown> {
      const response = await client.balanceTransactions.list({ limit: 25 });
      return Object.freeze({
        accountRegion: params.accountRegion,
        discrepancyId: params.discrepancyId,
        settlements: response.data,
      });
    },

    async stageRefund(params: {
      readonly chargeId: string;
      readonly amountUsd: number;
      readonly journalId?: string | undefined;
    }): Promise<unknown> {
      const amountCents = Math.round(params.amountUsd * 100);
      return client.refunds.create({
        charge: params.chargeId,
        amount: amountCents,
        metadata: {
          journalId: params.journalId ?? 'draft',
        },
      });
    },
  });
}
