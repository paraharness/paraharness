import { Octokit } from '@octokit/rest';
import { DEFAULT_GITHUB_API_BASE_URL } from '../../builders/internal/github-builder-defaults.constants.js';
import type { GithubHttpTransport } from '../github-http-transport.js';

/**
 * Subset of HTTP fetch request initialization options passed by `@octokit/rest`.
 *
 * Captures the HTTP request method and serialized JSON body string.
 */
export interface GithubOctokitFetchOptions {
  /** Optional HTTP method name (`'GET'`, `'POST'`, `'PATCH'`, etc.). */
  readonly method?: string;
  /** Optional serialized JSON body payload. */
  readonly body?: unknown;
}

/**
 * Creates a fetch-compatible adapter function delegating `@octokit/rest` requests to `transport`.
 *
 * Parses the URL path and JSON body before invoking `transport.request(method, path, { token, body })`.
 *
 * @param {string}              token     - Resolved GitHub authentication token.
 * @param {GithubHttpTransport} transport - Active `GithubHttpTransport` implementation.
 *
 * @returns {(url: string | URL | Request, init?: GithubOctokitFetchOptions) => Promise<Response>} Fetch adapter function.
 */
function createTransportFetchAdapter(
  token: string,
  transport: GithubHttpTransport,
): (url: string | URL | Request, init?: GithubOctokitFetchOptions) => Promise<Response> {
  return async (
    url: string | URL | Request,
    init?: GithubOctokitFetchOptions,
  ): Promise<Response> => {
    const parsedUrl = new URL(String(url));
    const path = `${parsedUrl.pathname}${parsedUrl.search}`;
    const rawMethod = (init?.method ?? 'GET').toUpperCase();
    const method = rawMethod as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    const body: unknown =
      typeof init?.body === 'string' && init.body.length > 0 ? JSON.parse(init.body) : undefined;
    const data = await transport.request(method, path, { token, body });
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

/**
 * Creates an `@octokit/rest` `Octokit` client authenticated with `token` and bridged to `transport`.
 *
 * Bridges `request.fetch` through `createTransportFetchAdapter(token, transport)` so both
 * `defaultGithubHttpTransport` and injected test transports share the same execution path.
 *
 * @param {string}              token     - Resolved GitHub authentication token.
 * @param {GithubHttpTransport} transport - Active `GithubHttpTransport` implementation.
 *
 * @returns {Octokit} Configured `@octokit/rest` client instance.
 */
export function createGithubOctokitClient(
  token: string,
  transport: GithubHttpTransport,
): Octokit {
  return new Octokit({
    auth: token,
    baseUrl: DEFAULT_GITHUB_API_BASE_URL,
    request: {
      fetch: createTransportFetchAdapter(token, transport),
    },
  });
}
