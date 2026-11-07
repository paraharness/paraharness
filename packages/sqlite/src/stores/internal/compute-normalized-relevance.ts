import MiniSearch from 'minisearch';

/**
 * Candidate lesson document shape passed to `computeNormalizedRelevanceScores`.
 */
export interface RelevanceCandidateParams {
  /** Unique lesson identifier. */
  readonly id: string;
  /** Lesson directive text $L$. */
  readonly directive: string;
  /** Optional topology partition identifier associated with the lesson. */
  readonly partition?: string | null;
}

/**
 * Indexed document entry added to the internal `MiniSearch` instance.
 */
export interface MiniSearchLessonEntryOptions {
  /** Unique lesson identifier. */
  readonly id: string;
  /** Lesson directive text $L$. */
  readonly directive: string;
  /** Partition string (empty string when global). */
  readonly partition: string;
}

/**
 * Computes normalized BM25 + fuzzy/prefix relevance scores $R(L, Q) \in [0, 1]$ across `candidates` using `MiniSearch`.
 *
 * Indexes `directive` and `partition` with `{ prefix: true, fuzzy: 0.2 }`, returning `1.0` for all candidates when
 * `queryText` is empty, `score / maxScore` when `maxScore > 0`, and `0` when a candidate does not match (`SPEC.md` §3.4.3).
 *
 * @param {readonly RelevanceCandidateParams[]} candidates - Candidate lessons to score.
 * @param {string}                              queryText  - Search query text $Q$.
 *
 * @returns {ReadonlyMap<string, number>} Map of candidate `id` to normalized relevance score $R(L, Q) \in [0, 1]$.
 */
export function computeNormalizedRelevanceScores(
  candidates: readonly RelevanceCandidateParams[],
  queryText: string,
): ReadonlyMap<string, number> {
  const scores = new Map<string, number>();
  if (candidates.length === 0) {
    return scores;
  }
  const trimmedQuery = queryText.trim();
  if (trimmedQuery.length === 0) {
    for (const candidate of candidates) {
      scores.set(candidate.id, 1);
    }
    return scores;
  }
  const miniSearch = new MiniSearch<MiniSearchLessonEntryOptions>({
    fields: ['directive', 'partition'],
    searchOptions: { prefix: true, fuzzy: 0.2 },
  });
  for (const candidate of candidates) {
    miniSearch.add({
      id: candidate.id,
      directive: candidate.directive,
      partition: candidate.partition ?? '',
    });
    scores.set(candidate.id, 0);
  }
  const results = miniSearch.search(trimmedQuery);
  const maxScore = results[0]?.score ?? 0;
  if (maxScore <= 0) {
    return scores;
  }
  for (const result of results) {
    const normalized = Math.max(0, Math.min(1, Number((result.score / maxScore).toFixed(6))));
    scores.set(String(result.id), normalized);
  }
  return scores;
}

/**
 * Computes normalized text relevance $R(L, Q) \in [0, 1]$ between a single lesson `directive` and `queryText` via `MiniSearch`.
 *
 * Returns `1` when `queryText` is empty or matches `directive` under BM25 + prefix/fuzzy search, and `0` when no terms match.
 *
 * @param {string} directive   - Lesson directive text $L$.
 * @param {string} queryText   - Search query text $Q$.
 * @param {string} [partition] - Optional partition identifier associated with the lesson.
 *
 * @returns {number} Normalized similarity score $R(L, Q) \in [0, 1]$.
 */
export function computeNormalizedRelevance(
  directive: string,
  queryText: string,
  partition?: string,
): number {
  const scores = computeNormalizedRelevanceScores([{ id: '0', directive, partition }], queryText);
  return scores.get('0') ?? 0;
}
