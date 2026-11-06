import type { RuntimeExecutorRegistrySlice } from '@harness-dsl/core';
import { createStripeExecutors } from './create-stripe-executors.js';

/** Default frozen `RuntimeExecutorRegistrySlice` for `@harness-dsl/stripe`. */
export const stripeExecutors: RuntimeExecutorRegistrySlice = createStripeExecutors();
