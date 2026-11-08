import type { StripeGateway } from './stripe-gateway.js';

/** Default offline in-memory `StripeGateway` fallback used when no live `Stripe` client or API key is injected. */
export const defaultStripeGateway: StripeGateway = Object.freeze<StripeGateway>({
  async listSettlements(): Promise<unknown> {
    return undefined;
  },
  async stageRefund(): Promise<unknown> {
    return undefined;
  },
});
