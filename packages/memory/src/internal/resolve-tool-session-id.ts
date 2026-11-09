import { MemoryHarnessError } from '../memory-harness-error.js';
import { SessionIdSchema, type SessionId } from '../schemas/memory-tools.schema.js';
import { SESSION_ID_ENV_VARS } from './memory-protocol.constants.js';

/**
 * Resolves and validates the active `sessionId` for `memory_init` and `memory_load_scoped` (§6.2 Step 1, §6.3 Step 2).
 *
 * When `explicitSessionId` is provided, validates it strictly via `SessionIdSchema` (throwing
 * `MemoryHarnessError` with `'VALIDATION_FAILED'` on failure). When omitted, checks environment
 * variables in order (`CLAUDE_SESSION_ID`, then `AGY_SESSION_ID`) via `SessionIdSchema.safeParse`,
 * ignoring empty or non-matching environment values.
 *
 * @param {string | undefined}                           explicitSessionId - Optional explicit `sessionId` from tool input.
 * @param {Readonly<Record<string, string | undefined>>} [env=process.env] - Optional environment map override.
 *
 * @returns {SessionId | undefined} Validated session identifier, or `undefined` if none is available.
 *
 * @throws {MemoryHarnessError} With `'VALIDATION_FAILED'` when `explicitSessionId` is provided and invalid.
 */
export function resolveToolSessionId(
  explicitSessionId: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): SessionId | undefined {
  if (explicitSessionId !== undefined) {
    const parsedExplicit = SessionIdSchema.safeParse(explicitSessionId);
    if (!parsedExplicit.success) {
      throw new MemoryHarnessError(
        'VALIDATION_FAILED',
        `Invalid sessionId '${explicitSessionId}': ${parsedExplicit.error.message}`,
        { sessionId: explicitSessionId, issues: parsedExplicit.error.issues },
      );
    }
    return parsedExplicit.data;
  }
  for (const envVarName of SESSION_ID_ENV_VARS) {
    const rawEnvValue = env[envVarName];
    if (typeof rawEnvValue !== 'string') {
      continue;
    }
    const trimmedEnvValue = rawEnvValue.trim();
    if (trimmedEnvValue.length === 0) {
      continue;
    }
    const parsedEnv = SessionIdSchema.safeParse(trimmedEnvValue);
    if (parsedEnv.success) {
      return parsedEnv.data;
    }
  }
  return undefined;
}
