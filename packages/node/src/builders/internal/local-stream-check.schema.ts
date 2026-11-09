import { z } from '@paraharness/core';

/**
 * Shared input schema (`z.unknown()`) attached to compiled `LocalStreamCheckNode` descriptors.
 *
 * Reused across `.toAST()` invocations so `LocalStreamCheckNode` descriptors with identical
 * configuration compare deeply equal.
 */
export const LOCAL_STREAM_CHECK_INPUT_SCHEMA = z.unknown();

/**
 * Shared output schema attached to compiled `LocalStreamCheckNode` descriptors.
 *
 * Validates `{ ok: boolean, deficits: readonly string[] }` when a `LocalStreamCheckNode` is executed as a step.
 */
export const LOCAL_STREAM_CHECK_OUTPUT_SCHEMA = z.object({
  ok: z.boolean(),
  deficits: z.array(z.string()).readonly(),
});
