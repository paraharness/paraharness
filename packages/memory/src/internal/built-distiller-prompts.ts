/**
 * Prompt pair returned by `buildDistillerPrompts` (§6.4 Step 3).
 */
export interface BuiltDistillerPrompts {
  /** Static KV-cacheable system prompt containing instructions, repository rules, and existing `R*`/`L*` records. */
  readonly systemPrompt: string;
  /** Dynamic user prompt containing the candidate payload, `bucketStatus`, and choice-scope constraints. */
  readonly userPrompt: string;
}
