import type { OpenAiHttpRequest } from './openai-http-request.js';
import type { OpenAiHttpResponse } from './openai-http-response.js';
import type { OpenAiHttpTransport } from './openai-http-transport.js';

/** Default OpenAI Responses API HTTPS endpoint URL. */
export const OPENAI_RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';

/** Regex matching account-bound OpenAI server item identifiers (`rs_...`, `fc_...`, `msg_...`, `resp_...`). */
export const OPENAI_SERVER_ITEM_ID_PATTERN = /^(?:rs_|fc_|msg_|resp_)/;

/** Default `fetch`-backed HTTP transport implementation for OpenAI `/v1/responses`. */
export const defaultOpenAiHttpTransport: OpenAiHttpTransport = Object.freeze<OpenAiHttpTransport>({
  async sendResponsesRequest(request: OpenAiHttpRequest): Promise<OpenAiHttpResponse> {
    request.signal?.throwIfAborted();
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: request.signal,
    });
    const rawText = await response.text();
    const parsedBody =
      rawText.trim().length > 0
        ? (JSON.parse(rawText) as Readonly<Record<string, unknown>>)
        : Object.freeze({});
    const retryAfterHeader = response.headers.get('retry-after');
    const resetAtMs =
      retryAfterHeader !== null && !Number.isNaN(Number(retryAfterHeader))
        ? Date.now() + Number(retryAfterHeader) * 1_000
        : undefined;
    return Object.freeze<OpenAiHttpResponse>({
      status: response.status,
      body: parsedBody,
      resetAtMs,
    });
  },
});
