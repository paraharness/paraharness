/** Default TCP port for the GitHub webhook HTTP listener (`SPEC.md` §4.5). */
export const DEFAULT_GITHUB_WEBHOOK_PORT = 3000;

/** Default HTTP route path for incoming GitHub webhook deliveries (`SPEC.md` §4.5). */
export const DEFAULT_GITHUB_WEBHOOK_PATH = '/webhooks/github';

/** Default base branch name when `baseBranch` projection is omitted. */
export const DEFAULT_GITHUB_BASE_BRANCH = 'main';

/** Default GitHub REST API base URL. */
export const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';

/** Default page size (`per_page`) when paginating open GitHub issues (`SPEC.md` §4.5). */
export const DEFAULT_GITHUB_ISSUES_PER_PAGE = 100;

/** Maximum allowed HTTP webhook request body size in bytes (10 MiB) before rejecting with HTTP 413. */
export const DEFAULT_MAX_GITHUB_WEBHOOK_BODY_BYTES = 10 * 1024 * 1024;
