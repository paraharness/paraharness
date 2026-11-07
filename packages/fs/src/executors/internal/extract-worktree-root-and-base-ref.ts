/**
 * Extracts `rootPath` and optional `baseRef` from an opaque isolation `scopeHandle`.
 *
 * Defaults `rootPath` to `process.cwd()` when `scopeHandle` does not carry a `worktreePath`
 * string (`SPEC.md` Invariant 5 & §4.3).
 *
 * @param {unknown} scopeHandle - Active isolation scope handle or `undefined`.
 *
 * @returns {{ readonly rootPath: string; readonly baseRef: string | undefined }} Resolved root directory and optional git `baseRef`.
 */
export function extractWorktreeRootAndBaseRef(scopeHandle: unknown): {
  readonly rootPath: string;
  readonly baseRef: string | undefined;
} {
  if (typeof scopeHandle !== 'object' || scopeHandle === null) {
    return Object.freeze({ rootPath: process.cwd(), baseRef: undefined });
  }
  const record = scopeHandle as Readonly<Record<string, unknown>>;
  const rawWorktreePath = record['worktreePath'];
  const rootPath =
    typeof rawWorktreePath === 'string' && rawWorktreePath.trim().length > 0
      ? rawWorktreePath
      : process.cwd();
  const rawBaseRef = record['baseRef'];
  const baseRef =
    typeof rawBaseRef === 'string' && rawBaseRef.trim().length > 0 ? rawBaseRef : undefined;
  return Object.freeze({ rootPath, baseRef });
}
