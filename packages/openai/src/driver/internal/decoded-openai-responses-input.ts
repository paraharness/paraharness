/**
 * Decoded OpenAI `/v1/responses` `input` item list and optional `previous_response_id` extracted from conversation history.
 *
 * Returned by `decodeHistoryToOpenAiResponsesInput()` and consumed by `buildOpenAiResponsesRequest()`.
 */
export interface DecodedOpenAiResponsesInput {
  /** Flattened OpenAI `/v1/responses` `input` items across all decoded history frames. */
  readonly inputItems: readonly Readonly<Record<string, unknown>>[];
  /** Optional server-side `previous_response_id` preserved when staying on the same OpenAI account seat. */
  readonly previousResponseId?: string | undefined;
}
