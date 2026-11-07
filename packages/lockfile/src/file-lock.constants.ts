import PQueue from 'p-queue';

/** Default maximum wait time in milliseconds before `acquireFileLock` times out. */
export const DEFAULT_LOCK_TIMEOUT_MS = 15_000;

/** Default maximum age in milliseconds without a heartbeat before a lockfile is treated as stale. */
export const DEFAULT_LOCK_STALE_MS = 10_000;

/** Default interval in milliseconds between `utimes` heartbeat updates while a lock is held. */
export const DEFAULT_LOCK_HEARTBEAT_INTERVAL_MS = 1_000;

/** Default polling backoff delay in milliseconds when waiting on a cross-process lockfile. */
export const DEFAULT_LOCK_RETRY_DELAY_MS = 15;

/** Process-local registry mapping canonical resolved lock paths to `concurrency: 1` serialization queues. */
export const LOCK_PATH_QUEUES = new Map<string, PQueue>();
