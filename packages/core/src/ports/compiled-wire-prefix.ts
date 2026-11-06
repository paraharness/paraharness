/**
 * JSON-serializable tool schema entry compiled into `CompiledWirePrefix`.
 *
 * Stored in `LedgerStore.compiledPrefixesJson` so provider `tools` arrays remain byte-identical
 * across process restarts and warm forks.
 */
export interface WireToolSchema {
  /** Wire-level function name of the tool. */
  readonly name: string;
  /** Tool description (including any `[Requires active skill: <id>]` or `[Role: <actorId>]` suffix). */
  readonly description: string;
  /** Pure JSON-serializable JSON Schema object compiled from the tool's Zod `inputSchema`. */
  readonly inputJsonSchema: Readonly<Record<string, unknown>>;
}

/**
 * Run-start snapshot of a `.sharedGrounding()` source persisted on `CompiledWirePrefix`.
 *
 * Enables computing in-run `updatedGroundingDiffs` across process restarts without mutating
 * byte 0 of `systemPromptText`.
 */
export interface GroundingSnapshotRecord {
  /** Identifier of the grounding `SourceASTNode`. */
  readonly sourceId: string;
  /** Full UTF-8 text of the grounding source at run start. */
  readonly text: string;
  /** SHA-256 hex digest of `text` at run start. */
  readonly digest: string;
}

/**
 * Run-immutable compiled prefix group artifact persisted in `LedgerStore.compiledPrefixesJson`.
 *
 * Keys provider KV prefix caches on a byte-identical `systemPromptText` and role-scoped (or union)
 * `wireToolSchemasByRoleKey` map across all actors and forks in the group.
 */
export interface CompiledWirePrefix {
  /** Identifier of the `PrefixGroupNode` from which this prefix was compiled. */
  readonly prefixGroupId: string;
  /** Tool schema transmission mode (`'role-scoped'` vs `'union'`). */
  readonly toolsMode: 'role-scoped' | 'union';
  /** Concatenated shared grounding, shared instructions, and global rules text. */
  readonly systemPromptText: string;
  /** SHA-256 hex digest of `systemPromptText` and `wireToolSchemasByRoleKey`. */
  readonly systemDigest: string;
  /** Run-start snapshots of `.sharedGrounding()` sources in AST declaration order. */
  readonly groundingSnapshots: readonly GroundingSnapshotRecord[];
  /** Map of canonical `roleKey` (or `'*'` in `'union'` mode) to its ordered `WireToolSchema[]`. */
  readonly wireToolSchemasByRoleKey: Readonly<Record<string, readonly WireToolSchema[]>>;
}
