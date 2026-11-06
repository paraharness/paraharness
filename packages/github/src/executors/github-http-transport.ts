/**
 * Pluggable HTTP transport abstraction for GitHub REST API requests.
 *
 * Allows `GithubIssuesTrackerAdapter` and `executeGithubCreateOrUpdatePrStep` to operate over
 * either `defaultGithubHttpTransport` (`fetch`) or deterministic recorded transports in tests.
 */
export interface GithubHttpTransport {
  /**
   * Executes an authenticated HTTP request against a GitHub REST API endpoint path.
   *
   * Serializes `options.body` as JSON when present and parses the JSON response payload.
   *
   * @template TResponse Parsed JSON response type.
   *
   * @param {'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'} method  - HTTP request method.
   * @param {string}                                      path    - Relative GitHub API path starting with `'/'`.
   * @param {object}                                      options - Bearer token and optional JSON body payload.
   *
   * @returns {Promise<TResponse>} Parsed JSON response returned by the GitHub REST API.
   */
  request<TResponse = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    options: {
      readonly token: string;
      readonly body?: unknown;
    },
  ): Promise<TResponse>;
}
