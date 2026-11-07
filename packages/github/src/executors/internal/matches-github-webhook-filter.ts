/**
 * Event and repository filter options for `matchesGithubWebhookFilter`.
 *
 * Holds the pre-indexed set of subscribed event names and optional repository slug filter.
 */
export interface GithubWebhookFilterOptions {
  /** Pre-indexed set of subscribed GitHub webhook event names. */
  readonly subscribedEvents: ReadonlySet<string>;
  /** Optional GitHub repository slug in `'owner/repo'` format. */
  readonly repo?: string;
}

/**
 * Determines whether an incoming GitHub webhook event matches the stream node's event and repo filters.
 *
 * Matches both bare event names (`'pull_request'`) and action-qualified event names (`'pull_request.closed'`).
 *
 * @param {string | undefined}                eventHeader  - Value of the `X-GitHub-Event` HTTP header.
 * @param {Readonly<Record<string, unknown>>} payload      - Parsed JSON webhook delivery payload.
 * @param {GithubWebhookFilterOptions}        filterConfig - Subscribed event set and optional repository filter.
 *
 * @returns {boolean} True when the delivery matches both the subscribed events and optional repository slug.
 */
export function matchesGithubWebhookFilter(
  eventHeader: string | undefined,
  payload: Readonly<Record<string, unknown>>,
  filterConfig: GithubWebhookFilterOptions,
): boolean {
  if (typeof eventHeader !== 'string' || eventHeader.length === 0) {
    return false;
  }
  const action = payload['action'];
  const qualifiedEvent = typeof action === 'string' ? `${eventHeader}.${action}` : eventHeader;
  const eventMatched =
    filterConfig.subscribedEvents.has(eventHeader) ||
    filterConfig.subscribedEvents.has(qualifiedEvent);
  if (!eventMatched) {
    return false;
  }
  if (filterConfig.repo === undefined) {
    return true;
  }
  const repoObj = payload['repository'];
  if (typeof repoObj !== 'object' || repoObj === null) {
    return false;
  }
  const fullName = (repoObj as Readonly<Record<string, unknown>>)['full_name'];
  return fullName === filterConfig.repo;
}
