import { Octokit } from '@octokit/rest';
import { DEFAULT_GITHUB_API_BASE_URL } from '../../builders/internal/github-builder-defaults.constants.js';
import { defaultGithubHttpTransport } from '../default-github-http-transport.constants.js';
import type { GithubHttpTransport } from '../github-http-transport.js';

/**
 * Splits a `"owner/repo"` repository slug into validated `owner` and `repo` segments.
 *
 * Throws an actionable error if `repoSlug` does not contain non-empty `owner` and `repo` parts.
 *
 * @param {string} repoSlug - Repository slug in `"owner/repo"` format.
 *
 * @returns {{ readonly owner: string; readonly repo: string }} Parsed repository owner and name.
 */
export function parseGithubRepoSlug(repoSlug: string): {
  readonly owner: string;
  readonly repo: string;
} {
  const slashIndex = repoSlug.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= repoSlug.length - 1) {
    throw new Error(
      `Invalid GitHub repository slug '${repoSlug}': expected '<owner>/<repo>' format.`,
    );
  }
  return Object.freeze({
    owner: repoSlug.slice(0, slashIndex),
    repo: repoSlug.slice(slashIndex + 1),
  });
}

/**
 * Creates an `@octokit/rest` `Octokit` client authenticated with `token` and bridged to `transport`.
 *
 * Uses native `Octokit` HTTP dispatch when `transport === defaultGithubHttpTransport`, or adapts
 * `request.fetch` to delegate through an injected `GithubHttpTransport` test double.
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
  if (transport === defaultGithubHttpTransport) {
    return new Octokit({
      auth: token,
      baseUrl: DEFAULT_GITHUB_API_BASE_URL,
    });
  }
  return new Octokit({
    auth: token,
    baseUrl: DEFAULT_GITHUB_API_BASE_URL,
    request: {
      fetch: async (
        url: string | URL | Request,
        init?: { readonly method?: string; readonly body?: unknown },
      ): Promise<Response> => {
        const parsedUrl = new URL(String(url));
        const path = `${parsedUrl.pathname}${parsedUrl.search}`;
        const rawMethod = (init?.method ?? 'GET').toUpperCase();
        const method = rawMethod as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
        const body: unknown =
          typeof init?.body === 'string' && init.body.length > 0
            ? JSON.parse(init.body)
            : undefined;
        const data = await transport.request(method, path, { token, body });
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
  });
}
