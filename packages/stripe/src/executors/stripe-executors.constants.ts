import type { RuntimeExecutorRegistrySlice } from '@metaharness/core';
import { createStripeExecutors } from './create-stripe-executors.js';

/** Default frozen `RuntimeExecutorRegistrySlice` for `@metaharness/stripe`. */
export const stripeExecutors: RuntimeExecutorRegistrySlice = createStripeExecutors();
