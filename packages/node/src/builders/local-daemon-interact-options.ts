import type { z } from '@harness-dsl/core';

/**
 * Runtime context supplied to `local.daemon` `.start()`, `.stopCommand()`, and `.interact()` command factories.
 *
 * Provides dynamically allocated conflict-free TCP ports, the collision-free hash-suffixed `scopeKey`,
 * and the optional isolation scope `worktreePath`.
 */
export interface LocalDaemonCommandContext {
  /** Dynamically allocated conflict-free TCP port numbers keyed by `.port(name)`. */
  readonly ports: Readonly<Record<string, number>>;
  /** Sanitized and SHA-256-suffixed scope key (`${sanitizedPrefix}-${sha256(rawScopeKey).slice(0, 8)}`). */
  readonly scopeKey: string;
  /** Optional filesystem path of the active isolation scope worktree. */
  readonly worktreePath?: string;
}

/**
 * Serializable regular expression descriptor used for `frameDelimiter` when specified as an object.
 *
 * Stores the regex pattern string and optional regex flags for passive AST serialization.
 */
export interface LocalDaemonRegexDescriptor {
  /** Regular expression pattern source string. */
  readonly pattern: string;
  /** Optional regular expression flags (e.g. `'m'`, `'i'`). */
  readonly flags?: string;
}

/**
 * Configuration options for registering a framed PTY interaction tool on `local.daemon(id).interact(toolName, options)`.
 *
 * Defines the command factory, prompt frame delimiter, output settle quiet window, and turn timeout.
 *
 * @template TInput Validated tool input payload type (defaults to `{ readonly input: string }`).
 */
export interface LocalDaemonInteractOptions<TInput = { readonly input: string }> {
  /** Optional human-readable tool description (defaults to `` `Interact with service via ${toolName}` ``). */
  readonly description?: string;
  /** Optional Zod input validation schema (defaults to `z.object({ input: z.string() })`). */
  readonly inputSchema?: z.ZodType<TInput, z.ZodTypeDef, unknown>;
  /** Pure factory mapping allocated ports, sanitized `scopeKey`, and `worktreePath` to the interactive CLI `argv`. */
  readonly command: (ctx: LocalDaemonCommandContext) => readonly string[];
  /** Prompt delimiter string, `RegExp`, or serialized pattern descriptor marking the end of each output frame. */
  readonly frameDelimiter: string | RegExp | LocalDaemonRegexDescriptor;
  /** Quiet window in milliseconds after `frameDelimiter` matches before resolving the turn output. */
  readonly idleSettleMs: number;
  /** Maximum timeout in seconds for draining the banner or completing a single interactive turn. */
  readonly timeoutSeconds: number;
}
