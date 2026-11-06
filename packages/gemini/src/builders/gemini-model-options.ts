/**
 * Configuration options for declaring a Google Gemini model via `gemini.model(alias, options)`.
 *
 * Specifies the provider-level model identifier transmitted to `/v1beta/models/{model}:generateContent`
 * and the optional thinking level applied across turns.
 */
export interface GeminiModelOptions {
  /** Google Gemini wire model identifier (such as `'gemini-2.5-pro'` or `'gemini-2.5-flash'`). */
  readonly id: string;
  /** Optional thinking level (`'low' | 'medium' | 'high'`). */
  readonly effort?: 'low' | 'medium' | 'high';
}
