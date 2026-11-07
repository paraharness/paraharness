/**
 * Parameters for creating an OpenAI SDK `fetch` wrapper via `createOpenAiSdkFetch()`.
 *
 * Specifies whether the seat provided an explicit bearer credential and the underlying `fetch` function.
 */
export interface CreateOpenAiSdkFetchParams {
  /** Whether the seat provided an explicit `authorization` bearer credential. */
  readonly hasExplicitAuth: boolean;
  /** Underlying `fetch` implementation to invoke. */
  readonly baseFetch: typeof globalThis.fetch;
}

/**
 * Wraps the target `fetch` function used by the `openai` SDK to preserve exact seat headers.
 *
 * Removes the placeholder `authorization` header injected by the SDK when `params.hasExplicitAuth` is `false`.
 *
 * @param {CreateOpenAiSdkFetchParams} params - Explicit auth flag and underlying `fetch` implementation.
 *
 * @returns {typeof globalThis.fetch} Wrapped `fetch` function passed to `new OpenAI({ fetch })`.
 */
export function createOpenAiSdkFetch(
  params: CreateOpenAiSdkFetchParams,
): typeof globalThis.fetch {
  const { hasExplicitAuth, baseFetch } = params;
  return (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const mergedHeaders = new Headers(init?.headers);
    if (!hasExplicitAuth) {
      mergedHeaders.delete('authorization');
    }
    return baseFetch(input, { ...init, headers: mergedHeaders });
  };
}
