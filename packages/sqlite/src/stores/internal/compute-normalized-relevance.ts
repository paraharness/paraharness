/**
 * Computes normalized token and character-trigram text similarity $R(L, Q) \in [0, 1]$ between a lesson `directive` and `queryText`.
 *
 * Combines alphanumeric token overlap with 3-gram Sørensen-Dice similarity so both exact keyword matches
 * and morphological variants score deterministically in `[0, 1]` (`SPEC.md` §3.4.3).
 *
 * @param {string} directive - Lesson directive text $L$.
 * @param {string} queryText - Search query text $Q$.
 *
 * @returns {number} Normalized similarity score $R(L, Q) \in [0, 1]$.
 */
export function computeNormalizedRelevance(directive: string, queryText: string): number {
  const normDirective = directive.toLowerCase().trim();
  const normQuery = queryText.toLowerCase().trim();
  if (normDirective.length === 0 || normQuery.length === 0) {
    return 0;
  }
  if (normDirective === normQuery) {
    return 1;
  }
  const extractTokens = (text: string): Set<string> => {
    const tokens = new Set<string>();
    let current = '';
    for (let idx = 0; idx < text.length; idx += 1) {
      const code = text.charCodeAt(idx);
      const isAlphaNum =
        (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 95;
      if (isAlphaNum) {
        current += text[idx] ?? '';
      } else if (current.length >= 2) {
        tokens.add(current);
        current = '';
      } else {
        current = '';
      }
    }
    if (current.length >= 2) {
      tokens.add(current);
    }
    return tokens;
  };
  const directiveTokens = extractTokens(normDirective);
  const queryTokens = extractTokens(normQuery);
  let sharedTokens = 0;
  for (const token of queryTokens) {
    if (directiveTokens.has(token)) {
      sharedTokens += 1;
    }
  }
  const tokenCoverage = queryTokens.size > 0 ? sharedTokens / queryTokens.size : 0;
  const extractTrigrams = (text: string): Set<string> => {
    const trigrams = new Set<string>();
    for (let idx = 0; idx + 3 <= text.length; idx += 1) {
      trigrams.add(text.slice(idx, idx + 3));
    }
    return trigrams;
  };
  const dirTrigrams = extractTrigrams(normDirective);
  const qryTrigrams = extractTrigrams(normQuery);
  let sharedTrigrams = 0;
  for (const gram of qryTrigrams) {
    if (dirTrigrams.has(gram)) {
      sharedTrigrams += 1;
    }
  }
  const trigramDenom = dirTrigrams.size + qryTrigrams.size;
  const trigramDice = trigramDenom > 0 ? (2 * sharedTrigrams) / trigramDenom : 0;
  const combined = tokenCoverage * 0.7 + trigramDice * 0.3;
  if (combined <= 0) {
    return 0;
  }
  if (combined >= 1) {
    return 1;
  }
  return combined;
}
