import { DEFAULT_GITHUB_API_BASE_URL } from '../builders/internal/github-builder-defaults.constants.js';
import type { GithubHttpTransport } from './github-http-transport.js';

/** Default `fetch`-backed HTTP transport targeting `https://api.github.com`. */
export const defaultGithubHttpTransport: GithubHttpTransport = Object.freeze<GithubHttpTransport>({
  async request<TResponse = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    options: {
      readonly token: string;
      readonly body?: unknown;
    },
  ): Promise<TResponse> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.token}`,
      Accept: 'application/vnd.github+json',
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(`${DEFAULT_GITHUB_API_BASE_URL}${path}`, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `GitHub REST API request '${method} ${path}' failed with HTTP ${response.status}: ${errorText}`,
      );
    }
    return (await response.json()) as TResponse;
  },
});
