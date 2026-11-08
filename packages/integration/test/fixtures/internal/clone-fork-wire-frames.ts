import type { WireFrameRecord } from '@paraharness/core';

/**
 * Clones a parent `WireFrameRecord[]` chain for a `'clone-transcript'` downward fork (`M4-integration.md` §5).
 *
 * Re-keys `messageId` and `parentMessageId` deterministically using `forkSeq` while constructing each
 * `WireFrameRecord` with a monomorphic property shape.
 *
 * @param {readonly WireFrameRecord[]} parentChain - Parent conversation wire frame chain.
 * @param {number}                     forkSeq     - Positive 1-based fork sequence counter.
 *
 * @returns {readonly WireFrameRecord[]} Frozen cloned wire frame chain.
 */
export function cloneForkWireFrames(
  parentChain: readonly WireFrameRecord[],
  forkSeq: number,
): readonly WireFrameRecord[] {
  let prevId: string | null = null;
  const cloned: WireFrameRecord[] = [];
  for (const frame of parentChain) {
    const nextId = `${frame.messageId}:fork:${String(forkSeq)}`;
    cloned.push(
      Object.freeze<WireFrameRecord>({
        messageId: nextId,
        parentMessageId: prevId,
        vendorId: frame.vendorId,
        rawWireFrame: frame.rawWireFrame,
        canonical: frame.canonical,
        prefixDigest: frame.prefixDigest,
        compactedTombstones: frame.compactedTombstones,
      }),
    );
    prevId = nextId;
  }
  return Object.freeze(cloned);
}
