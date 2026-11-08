import type {
  GithubHttpRequestOptions,
  GithubHttpTransport,
} from '../../src/executors/github-http-transport.js';
import type { RecordedGithubCall } from './recorded-github-call.js';

/**
 * Deterministic in-memory `GithubHttpTransport` test double for `@metaharness/github` unit tests.
 *
 * Records all outbound REST API calls in invocation order and dispatches canned responses
 * registered by `(method, path)` key.
 */
export class RecordedGithubHttpTransport implements GithubHttpTransport {
  /** Ordered list of recorded GitHub HTTP requests. */
  public readonly calls: RecordedGithubCall[] = [];

  /** Pre-indexed map of canned responses keyed by `"${method} ${path}"`. */
  private readonly responses = new Map<string, unknown>();

  /**
   * Registers a deterministic canned response for `(method, path)`.
   *
   * Returned whenever `request(method, path, ...)` matches the registered route.
   *
   * @param {'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'} method   - HTTP method to match.
   * @param {string}                                      path     - Exact API path to match.
   * @param {unknown}                                     response - Canned response payload to return.
   *
   * @returns {void}
   */
  registerResponse(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    response: unknown,
  ): void {
    this.responses.set(`${method} ${path}`, response);
  }

  /**
   * Records an outbound GitHub API request and returns the registered canned response.
   *
   * Throws an actionable error if no canned response was registered for `"${method} ${path}"`.
   *
   * @template TResponse Expected response payload type.
   *
   * @param {'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'} method  - HTTP request method.
   * @param {string}                                      path    - Relative GitHub API path.
   * @param {GithubHttpRequestOptions}                    options - Bearer token and optional JSON body.
   *
   * @returns {Promise<TResponse>} Registered canned response payload.
   *
   * @throws {Error} If no canned response is registered for `"${method} ${path}"`.
   */
  async request<TResponse = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    options: GithubHttpRequestOptions,
  ): Promise<TResponse> {
    this.calls.push(
      Object.freeze<RecordedGithubCall>({
        method,
        path,
        token: options.token,
        body: options.body,
      }),
    );
    const key = `${method} ${path}`;
    if (!this.responses.has(key)) {
      throw new Error(`No canned GitHub response registered for '${key}'.`);
    }
    return this.responses.get(key) as TResponse;
  }
}
