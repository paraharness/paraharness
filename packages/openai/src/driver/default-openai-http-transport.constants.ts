import { sendOpenAiResponsesViaSdk } from './internal/openai-http-transport.js';
import type { OpenAiHttpRequest } from './openai-http-request.js';
import type { OpenAiHttpResponse } from './openai-http-response.js';
import type { OpenAiHttpTransport } from './openai-http-transport.js';

/** Default OpenAI Responses API HTTPS endpoint URL. */
export const OPENAI_RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';

/** Regex matching account-bound OpenAI server item identifiers (`rs_...`, `fc_...`, `msg_...`, `resp_...`). */
export const OPENAI_SERVER_ITEM_ID_PATTERN = /^(?:rs_|fc_|msg_|resp_)/;

/** Default `openai` SDK-backed HTTP transport implementation for OpenAI `/v1/responses`. */
export const defaultOpenAiHttpTransport: OpenAiHttpTransport = Object.freeze<OpenAiHttpTransport>({
  sendResponsesRequest(request: OpenAiHttpRequest): Promise<OpenAiHttpResponse> {
    return sendOpenAiResponsesViaSdk(request);
  },
});
