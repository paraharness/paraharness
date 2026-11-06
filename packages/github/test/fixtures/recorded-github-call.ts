/**
 * Recorded HTTP request entry captured by `RecordedGithubHttpTransport`.
 *
 * Stores the HTTP method, endpoint path, resolved Bearer token, and optional JSON request body
 * for deterministic assertion in unit tests.
 */
export interface RecordedGithubCall {
  /** HTTP request method (`'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'`). */
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Relative GitHub REST API path starting with `'/'`. */
  readonly path: string;
  /** Resolved authentication token passed in `options.token`. */
  readonly token: string;
  /** Optional JSON request body passed in `options.body`. */
  readonly body?: unknown;
}
