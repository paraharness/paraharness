/**
 * Parameters for constructing an `@anthropic-ai/sdk` `fetch` wrapper via `createAnthropicSdkFetch()`.
 *
 * Controls whether placeholder SDK auth headers are stripped when no seat credential is configured.
 */
export interface CreateAnthropicSdkFetchParams {
  /** Whether the active seat provided an explicit API key or OAuth bearer token. */
  readonly hasExplicitAuth: boolean;
  /** Underlying `fetch` implementation to invoke. */
  readonly baseFetch: typeof globalThis.fetch;
}

/**
 * Wraps the target `fetch` function used by `@anthropic-ai/sdk` to preserve exact seat headers.
 *
 * Removes placeholder `authorization` and `x-api-key` headers injected by the SDK when
 * `params.hasExplicitAuth` is `false`.
 *
 * @param {CreateAnthropicSdkFetchParams} params - Explicit auth flag and underlying `fetch` function.
 *
 * @returns {typeof globalThis.fetch} Wrapped `fetch` function passed to `new Anthropic({ fetch })`.
 */
export function createAnthropicSdkFetch(
  params: CreateAnthropicSdkFetchParams,
): typeof globalThis.fetch {
  return (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const mergedHeaders = new Headers(init?.headers);
    if (!params.hasExplicitAuth) {
      mergedHeaders.delete('authorization');
      mergedHeaders.delete('x-api-key');
    }
    return params.baseFetch(input, { ...init, headers: mergedHeaders });
  };
}
