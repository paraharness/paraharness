/**
 * In-run grounding diff entry computed when an actor mutates a `.sharedGrounding()` source mid-run.
 *
 * Injected into `[ROLE_AND_SCOPE_CONTEXT]` and `[TOPOLOGY_SYNC]` frames so byte 0 of `systemPromptText`
 * remains immutable throughout the run (`SPEC.md` §1.2 Invariant 6 & §3.2.1).
 */
export interface InRunGroundingDiffRecord {
  /** Identifier of the mutated grounding source. */
  readonly sourceId: string;
  /** SHA-256 digest captured at run start in `CompiledWirePrefix.groundingSnapshots`. */
  readonly previousDigest: string;
  /** Updated SHA-256 digest observed in the active isolation scope. */
  readonly currentDigest: string;
  /** Updated full text content loaded from the active isolation scope. */
  readonly updatedText: string;
}
