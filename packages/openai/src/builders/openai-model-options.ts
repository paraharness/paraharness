/**
 * Configuration options for declaring an OpenAI Responses API model via `openai.model(alias, options)`.
 *
 * Specifies the provider-level model identifier transmitted to `/v1/responses` and the optional
 * reasoning effort level applied across turns.
 */
export interface OpenAiModelOptions {
  /** OpenAI wire model identifier (such as `'gpt-5'` or `'o3'`). */
  readonly id: string;
  /** Optional reasoning effort level (`'low' | 'medium' | 'high'`). */
  readonly effort?: 'low' | 'medium' | 'high';
}
