import { createStripeAllowRefundLeaseDelta } from './create-stripe-allow-refund-lease-delta.js';
import { createStripeMaxRefundGuardBuilder } from './create-stripe-max-refund-guard-builder.js';
import { createStripeReadTools } from './create-stripe-read-tools.js';
import type { StripeNamespace } from './stripe-namespace-contract.js';

/** Frozen `@metaharness/stripe` DSL namespace singleton (`stripe.readTools`, `stripe.maxRefundGuardUsd`, `stripe.allowRefundUpToUsd`). */
export const stripe: StripeNamespace = Object.freeze<StripeNamespace>({
  readTools: createStripeReadTools,
  maxRefundGuardUsd: createStripeMaxRefundGuardBuilder,
  allowRefundUpToUsd: createStripeAllowRefundLeaseDelta,
});
