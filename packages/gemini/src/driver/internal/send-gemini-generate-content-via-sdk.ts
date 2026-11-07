import { ApiError, GoogleGenAI } from '@google/genai';
import type { GeminiHttpRequest } from '../gemini-http-request.js';
import type { GeminiHttpResponse } from '../gemini-http-response.js';
import { buildGeminiErrorHttpResponse } from './build-gemini-error-http-response.js';
import { createGeminiSdkFetch } from './create-gemini-sdk-fetch.js';
import type { GeminiSdkFetchCapture } from './gemini-sdk-fetch-capture.js';
import { parseGeminiRetryAfterResetAtMs } from './parse-gemini-retry-after-reset-at-ms.js';
import { resolveGeminiSdkEndpointParts } from './resolve-gemini-sdk-endpoint-parts.js';

/**
 * Dispatches a Google Gemini `generateContent` request through the official `@google/genai` `GoogleGenAI` client.
 *
 * Uses `ai.models.generateContent()` with `retryOptions: { attempts: 1 }` and transmits the exact wire body.
 *
 * @param {GeminiHttpRequest} request - Outbound Gemini `generateContent` request envelope.
 *
 * @returns {Promise<GeminiHttpResponse>} HTTP status, parsed JSON body or error text, and `resetAtMs`.
 *
 * @throws {Error} If `request.signal` is aborted or an unrecoverable transport exception occurs.
 */
export async function sendGeminiGenerateContentViaSdk(
  request: GeminiHttpRequest,
): Promise<GeminiHttpResponse> {
  request.signal?.throwIfAborted();
  const { baseUrl, apiVersion, modelId } = resolveGeminiSdkEndpointParts(request.url);
  const apiKey = request.headers['x-goog-api-key'];
  const hasExplicitApiKey = apiKey !== undefined && apiKey.length > 0;
  const capture: GeminiSdkFetchCapture = { status: undefined, retryAfter: null };
  const ai = new GoogleGenAI({
    apiKey: hasExplicitApiKey ? apiKey : 'gemini-seat-unconfigured',
    apiVersion,
    httpOptions: {
      baseUrl,
      headers: { ...request.headers },
      retryOptions: { attempts: 1 },
      fetch: createGeminiSdkFetch({
        hasExplicitApiKey,
        requestBody: request.body,
        baseFetch: request.fetch ?? globalThis.fetch,
        capture,
      }),
    },
  });
  try {
    const sdkResponse = await ai.models.generateContent({
      model: modelId,
      contents: 'turn',
      config: { abortSignal: request.signal },
    });
    return Object.freeze<GeminiHttpResponse>({
      status: capture.status ?? 200,
      body: {
        candidates: sdkResponse.candidates ?? [],
        usageMetadata: sdkResponse.usageMetadata,
      },
      bodyText: undefined,
      headers: undefined,
      resetAtMs: parseGeminiRetryAfterResetAtMs(
        capture.retryAfter ?? sdkResponse.sdkHttpResponse?.headers?.['retry-after'],
      ),
    });
  } catch (err: unknown) {
    const hasHttpErrorStatus =
      capture.status !== undefined && (capture.status < 200 || capture.status >= 300);
    if (err instanceof ApiError || hasHttpErrorStatus) {
      return buildGeminiErrorHttpResponse({ err, capture });
    }
    throw err;
  }
}
