import type { ForkContext, WireFrameRecord } from '@paraharness/core';

/**
 * Slices `ctx.parentChain` up to and including `ctx.forkPointMessageId` when specified.
 *
 * Returns the full `ctx.parentChain` when `forkPointMessageId` is `null` or does not match an entry.
 *
 * @param {ForkContext} ctx - Fork preparation context carrying `parentChain` and `forkPointMessageId`.
 *
 * @returns {readonly WireFrameRecord[]} Parent frames up to the fork point.
 */
export function sliceClaudeParentChain(ctx: ForkContext): readonly WireFrameRecord[] {
  if (ctx.forkPointMessageId === null) {
    return ctx.parentChain;
  }
  const sliced: WireFrameRecord[] = [];
  for (const frame of ctx.parentChain) {
    sliced.push(frame);
    if (frame.messageId === ctx.forkPointMessageId) {
      return Object.freeze(sliced);
    }
  }
  return ctx.parentChain;
}
