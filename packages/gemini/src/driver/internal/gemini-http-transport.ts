import { ApiError, GoogleGenAI } from '@google/genai';
import type { GeminiHttpRequest } from '../gemini-http-request.js';
import type { GeminiHttpResponse } from '../gemini-http-response.js';

/**
 * Parses an HTTP `retry-after` header value in seconds into an epoch timestamp in milliseconds.
 *
 * Returns `undefined` when the header is absent, empty, or not a finite number.
 *
 * @param {string | null | undefined} retryAfterHeader - Raw `retry-after` header string.
 *
 * @returns {number | undefined} Epoch timestamp in milliseconds when the rate-limit window resets.
 */
export function parseGeminiRetryAfterResetAtMs(
  retryAfterHeader: string | null | undefined,
): number | undefined {
  if (retryAfterHeader === null || retryAfterHeader === undefined || retryAfterHeader.trim().length === 0) {
    return undefined;
  }
  const seconds = Number(retryAfterHeader);
  return Number.isFinite(seconds) ? Date.now() + seconds * 1_000 : undefined;
}

/**
 * Splits a Gemini `generateContent` endpoint URL into `baseUrl`, `apiVersion`, and `modelId`.
 *
 * Extracts the model identifier from `/v1beta/models/{model}:generateContent` for `ai.models.generateContent()`.
 *
 * @param {string} endpointUrl - Full Gemini `generateContent` endpoint URL.
 *
 * @returns {{ readonly baseUrl: string; readonly apiVersion: string; readonly modelId: string }} Parsed SDK URL components.
 */
export function resolveGeminiSdkEndpointParts(endpointUrl: string): {
  readonly baseUrl: string;
  readonly apiVersion: string;
  readonly modelId: string;
} {
  const parsedUrl = new URL(endpointUrl);
  const match = /^\/(v1beta|v1alpha|v1)\/models\/([^/:]+):generateContent$/.exec(parsedUrl.pathname);
  return Object.freeze({
    baseUrl: parsedUrl.origin,
    apiVersion: match?.[1] ?? 'v1beta',
    modelId: match?.[2] ?? 'gemini-3.1-pro',
  });
}

/**
 * Converts an `@google/genai` `ApiError` or failed HTTP status into a `GeminiHttpResponse` envelope.
 *
 * Preserves the HTTP status code, raw error message, and `retry-after` reset timestamp without JSON parsing crashes.
 *
 * @param {unknown}            err            - Caught SDK exception.
 * @param {number | undefined} capturedStatus - HTTP status code captured from the underlying `fetch` response.
 * @param {string | null}      retryAfter     - Raw `retry-after` header captured from the `fetch` response.
 *
 * @returns {GeminiHttpResponse} Normalized error response descriptor.
 */
export function buildGeminiErrorHttpResponse(
  err: unknown,
  capturedStatus: number | undefined,
  retryAfter: string | null,
): GeminiHttpResponse {
  const status = err instanceof ApiError ? err.status : (capturedStatus ?? 500);
  const bodyText = err instanceof Error ? err.message : String(err);
  return Object.freeze<GeminiHttpResponse>({
    status,
    body: Object.freeze({}),
    bodyText,
    headers: undefined,
    resetAtMs: parseGeminiRetryAfterResetAtMs(retryAfter),
  });
}

/**
 * Dispatches a Google Gemini `generateContent` request through the official `@google/genai` `GoogleGenAI` client.
 *
 * Uses `ai.models.generateContent()` with `retryOptions: { attempts: 1 }` and transmits the exact wire body.
 *
 * @param {GeminiHttpRequest} request - Outbound Gemini `generateContent` request envelope.
 *
 * @returns {Promise<GeminiHttpResponse>} HTTP status, parsed JSON body or error text, and `resetAtMs`.
 */
export async function sendGeminiGenerateContentViaSdk(request: GeminiHttpRequest): Promise<GeminiHttpResponse> {
  request.signal?.throwIfAborted();
  const { baseUrl, apiVersion, modelId } = resolveGeminiSdkEndpointParts(request.url);
  const apiKey = request.headers['x-goog-api-key'];
  const hasKey = apiKey !== undefined && apiKey.length > 0;
  const baseFetch = request.fetch ?? globalThis.fetch;
  let capturedStatus: number | undefined;
  let capturedRetryAfter: string | null = null;
  const ai = new GoogleGenAI({
    apiKey: hasKey ? apiKey : 'gemini-seat-unconfigured',
    apiVersion,
    httpOptions: {
      baseUrl, headers: { ...request.headers }, retryOptions: { attempts: 1 },
      fetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const mergedHeaders = new Headers(init?.headers);
        if (!hasKey) mergedHeaders.delete('x-goog-api-key');
        const rawRes = await baseFetch(input, { ...init, headers: mergedHeaders, body: JSON.stringify(request.body) });
        capturedStatus = rawRes.status;
        capturedRetryAfter = rawRes.headers.get('retry-after');
        return rawRes;
      },
    },
  });
  try {
    const sdkRes = await ai.models.generateContent({ model: modelId, contents: 'turn', config: { abortSignal: request.signal } });
    return Object.freeze<GeminiHttpResponse>({
      status: capturedStatus ?? 200,
      body: { candidates: sdkRes.candidates ?? [], usageMetadata: sdkRes.usageMetadata },
      bodyText: undefined, headers: undefined,
      resetAtMs: parseGeminiRetryAfterResetAtMs(capturedRetryAfter ?? sdkRes.sdkHttpResponse?.headers?.['retry-after']),
    });
  } catch (err: unknown) {
    if (err instanceof ApiError || (capturedStatus !== undefined && (capturedStatus < 200 || capturedStatus >= 300))) {
      return buildGeminiErrorHttpResponse(err, capturedStatus, capturedRetryAfter);
    }
    throw err;
  }
}
