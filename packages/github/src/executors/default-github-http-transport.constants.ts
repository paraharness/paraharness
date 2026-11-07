import { Octokit } from '@octokit/rest';
import { DEFAULT_GITHUB_API_BASE_URL } from '../builders/internal/github-builder-defaults.constants.js';
import type { GithubHttpRequestOptions, GithubHttpTransport } from './github-http-transport.js';

/** Default `@octokit/rest`-backed HTTP transport targeting `https://api.github.com`. */
export const defaultGithubHttpTransport: GithubHttpTransport = Object.freeze<GithubHttpTransport>({
  async request<TResponse = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    options: GithubHttpRequestOptions,
  ): Promise<TResponse> {
    const octokit = new Octokit({
      auth: options.token,
      baseUrl: DEFAULT_GITHUB_API_BASE_URL,
    });
    const requestParams: Record<string, unknown> =
      typeof options.body === 'object' && options.body !== null
        ? { ...(options.body as Record<string, unknown>) }
        : {};
    const response = await octokit.request(`${method} ${path}`, requestParams);
    return response.data as TResponse;
  },
});
