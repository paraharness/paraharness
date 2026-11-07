/**
 * Extracts normalized lowercase alphanumeric word tokens and character 3-grams from `text`.
 *
 * Produces a deduplicated `Set<string>` used to compute Jaccard and query-coverage similarity in `[0, 1]`.
 *
 * @param {string} text - Input directive or search query string.
 *
 * @returns {Set<string>} Set of normalized word tokens and character trigrams.
 */
function extractTokensAndTrigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const features = new Set<string>();
  if (normalized.length === 0) return features;
  const words = normalized.split(/\s+/);
  for (const word of words) {
    if (word.length > 0) {
      features.add(`w:${word}`);
    }
    if (word.length >= 3) {
      for (let idx = 0; idx <= word.length - 3; idx += 1) {
        features.add(`g:${word.slice(idx, idx + 3)}`);
      }
    }
  }
  return features;
}

/**
 * Computes normalized text relevance $R(L, Q) \in [0, 1]$ between a lesson `directive` and `queryText`.
 *
 * Returns `1` when `queryText` is empty or identical to `directive`, and otherwise computes the
 * normalized token and character-trigram overlap coefficient in `[0, 1]` (`SPEC.md` §3.4.3).
 *
 * @param {string} directive - Lesson directive text $L$.
 * @param {string} queryText - Search query text $Q$.
 *
 * @returns {number} Normalized similarity score $R(L, Q) \in [0, 1]$.
 */
export function computeNormalizedRelevance(directive: string, queryText: string): number {
  const trimmedQuery = queryText.trim();
  if (trimmedQuery.length === 0) return 1;
  const directiveFeatures = extractTokensAndTrigrams(directive);
  const queryFeatures = extractTokensAndTrigrams(trimmedQuery);
  if (directiveFeatures.size === 0 || queryFeatures.size === 0) return 0;

  let intersectionCount = 0;
  for (const feature of queryFeatures) {
    if (directiveFeatures.has(feature)) {
      intersectionCount += 1;
    }
  }
  const unionCount = directiveFeatures.size + queryFeatures.size - intersectionCount;
  const jaccard = unionCount > 0 ? intersectionCount / unionCount : 0;
  const queryCoverage = intersectionCount / queryFeatures.size;
  const blended = 0.5 * jaccard + 0.5 * queryCoverage;
  return Math.max(0, Math.min(1, Number(blended.toFixed(6))));
}
