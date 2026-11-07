/**
 * Parsed URL components extracted from a Gemini `generateContent` endpoint URL.
 *
 * Returned by `resolveGeminiSdkEndpointParts()` and passed to `new GoogleGenAI(...)`.
 */
export interface GeminiSdkEndpointParts {
  /** Origin base URL (`https://generativelanguage.googleapis.com`). */
  readonly baseUrl: string;
  /** Gemini API version segment (`'v1beta' | 'v1alpha' | 'v1'`). */
  readonly apiVersion: string;
  /** Target Gemini model identifier (`'gemini-3.1-pro'`). */
  readonly modelId: string;
}
