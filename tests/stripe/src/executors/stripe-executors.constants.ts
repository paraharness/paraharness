import type { RuntimeExecutorRegistrySlice } from '@paraharness/core';
import { createStripeExecutors } from './create-stripe-executors.js';

/** Default frozen `RuntimeExecutorRegistrySlice` for `@paraharness/stripe`. */
export const stripeExecutors: RuntimeExecutorRegistrySlice = createStripeExecutors();
