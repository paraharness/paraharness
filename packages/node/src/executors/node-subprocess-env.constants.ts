/**
 * Static isolated `GIT_*` environment overrides injected when a scope handle provides `worktreePath`.
 *
 * Combined with `GIT_CEILING_DIRECTORIES=<path.dirname(worktreePath)>`, these 9 `GIT_*` variables
 * isolate worktree subprocesses from host git configs, locks, hooks, and GPG signing.
 */
export const ISOLATED_GIT_ENV_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'commit.gpgsign',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'core.hooksPath',
  GIT_CONFIG_VALUE_1: '/dev/null',
});

/** Grace period in milliseconds between `SIGTERM` and `SIGKILL` during process-group termination. */
export const DEFAULT_SUBPROCESS_GRACE_MS = 200;

/** Default timeout in milliseconds when probing daemon TCP port readiness after startup. */
export const DEFAULT_DAEMON_PORT_READY_TIMEOUT_MS = 10_000;

/** In-process registry of currently leased dynamic daemon TCP ports to prevent concurrent collisions. */
export const ACTIVE_LEASED_DAEMON_PORTS: Set<number> = new Set<number>();
