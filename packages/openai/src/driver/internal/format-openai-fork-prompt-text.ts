import type { ForkContext } from '@harness-dsl/core';

/**
 * Formats the combined child role context and task prompt text for a forked OpenAI child session.
 *
 * Joins `ctx.childRoleContextFrameText` and `ctx.childTaskPromptText` with a blank line when both are present.
 *
 * @param {ForkContext} ctx - Fork preparation context carrying child role context and task prompt text.
 *
 * @returns {string} Combined prompt text, or `''` when neither is present.
 */
export function formatOpenAiForkPromptText(ctx: ForkContext): string {
  const parts: string[] = [];
  if (ctx.childRoleContextFrameText !== undefined && ctx.childRoleContextFrameText.length > 0) {
    parts.push(ctx.childRoleContextFrameText);
  }
  if (ctx.childTaskPromptText !== undefined && ctx.childTaskPromptText.length > 0) {
    parts.push(ctx.childTaskPromptText);
  }
  return parts.join('\n\n');
}
