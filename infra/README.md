# Infrastructure

The gate, the deploy scripts and the provider notes. The contract is
[`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) §20 and §7–§9; day-to-day commands
live in [`../docs/RUNBOOK.md`](../docs/RUNBOOK.md).

The backend is the Cloudflare Workers in `apps/edge` since the 29 Sep 2026 switch
(their config is `apps/edge/wrangler.*.jsonc`; `scripts/edge-deploy.sh` deploys
them). The old stack — `apps/api` on Coolify behind a tunnel, MongoDB, Valkey, the
compose files, `deploy-api.sh`, `deploy-server.sh` and the Coolify dev stack — left this
repository then (CD-147); `parlornights/CrookedDukeOld` keeps `apps/api`, and the old server is
stopped, not deleted. Its deploy and rollback tools — `cutover.sh`, `coolify-deploy.sh`,
`cloudflare-setup.mjs`/`cloudflare-plan.mjs`, `Dockerfile.web` and `coolify-proxy.nginx.conf` —
followed on 29 Sep (owner, CD-160).

| File                           | What it is                                                     |
| ------------------------------ | -------------------------------------------------------------- |
| `e2e/fixtures.ts`               | the journeys' `test` for the app and the admin: a failed test attaches its DOM as `dom-excerpt` |
| `e2e/page-failures.ts`          | the journeys' page failures, merged into the app's and the admin's journey fixtures: `consoleWatch` (console and page errors, leaving a failed load's console line to the response check) and the auto fixture `pageFailures`, which fails a journey on a response of status 400 or more that the journey did not declare with `pageFailures.expect(<url pattern>, <status>)`; `pageFailures.watch(context)` adds a context the journey opens itself |
| `e2e/failure-dom.ts`            | the locators a failure message names, and what the open pages hold for each; used by `fixtures.ts` |
| `e2e/access.mjs`                | the Access service token on the protected origins only: `routeAccessHeaders` for a browser context (a route that follows a redirect itself, with the headers, only for GET and HEAD, only while the Location stays on the request's origin and for at most 10 hops, and fulfils the page at the URL it asked for; any other redirect goes back to the browser without the headers), which also opens the origins' WebSockets from Node with the same headers and returns `{ socketFailures, fetchFailures }`, the handshakes that failed and the fetches the route could not make; `requestAccessHeaders` for its API request context (never follows a redirect while carrying the token, `[access header]` in errors and logs); plain JS with `access.d.mts`, so the Node scripts import it too |
| `e2e/write-guard.mjs`           | the write guard the app's and the admin's journeys share, each with its own judge: `guardBrowserWrites` (every non-read request of a context is judged before it leaves the browser; a refused one is answered 405 by `refuseWrite`, and a write the judge did not allow whose response still came from a server is listed as having reached it), `guardApiWrites` (an `APIRequestContext`'s writes, judged before they are sent; a refused one throws), `READ_METHODS` (GET, HEAD and OPTIONS, never judged) and `refuseWrite`; plain JS with `write-guard.d.mts` |
| `e2e/reporters.ts`              | `liveReporters`: the list reporter, and a JSON report at `LIVE_REPORT` when it is set |
| `scripts/gate-passed.sh`       | what "the gate passed" means: the gate's statuses on GitHub (`gate-status.mjs`) — sourced by `edge-deploy.sh` |
| `scripts/deploy-ref.mjs`       | the commit `deploy.yml` deploys for a ref: the newest first-parent commit with `gate/tree`, past commits `gate-main.yml`'s push filter skips; a sha named only as named |
| `scripts/edge-deploy.sh`       | the Workers deploy Workers Builds runs ("Workers — Workers Builds"), and the bundle `checks.yml` builds with `--dry-run`: build the admin app, D1 migrations (cd-admin too), then `auth`, `admin`, then `api`; refuses a commit whose tree GitHub does not show passing the gate, a checkout that is not its tree, and a deploy whose vars differ from what runs live |
| `scripts/admin-hosts.mjs`      | the admin's hosts per stack (`admin[-dev].parlornights.com`) and the legacy hosts they replace: read from `packages/shared/src/admin/hosts.json`, the one place that names them, which the admin and the edge import as `ADMIN_HOSTS` from `@wg/shared/admin` (CD-377) |
| `scripts/release-version.mjs`  | its `notes` verb lists the PRs a production release merged, for `release-please.yml`'s proof-branch delete; a production version is release-please's `v5.N.0`, kept in `release/manifest.json` |
| `scripts/smoke-walk.mjs`       | the smoke walk after each release: health, web, walk-account sign-in, Home in Chromium, a pass in a bot game |
| `scripts/release-proofs.mjs`   | the proof branches of the PRs a production release merged, each kept while an open PR has its branch, read with its own GitHub client — run by `release-please.yml` |
| `scripts/linear-api.mjs`       | one Linear GraphQL request, as the QA makes it |
| `scripts/qa-e2e.mjs`           | a journeys' Playwright report as findings, and the run's own failures — run by `journeys-local.sh` |
| `scripts/qa-browser-env.sh`    | the runner account's Chromium, its libraries and its temp folder (`~/wg-verify`) — sourced by the smoke walk and `journeys-local.sh` |
| `scripts/qa-linear.mjs`        | the QA's findings in one open Linear batch issue per surface |
| `verify/qa-plan.mjs`           | what the QA runs for a release: screens, journeys and verifiers per surface, from the diff since the last QA-passed release |
| `verify/screens.mjs`           | each surface's screens, and the screens a changed file reaches through imports |
| `verify/journeys.mjs`          | the journeys and the screens each declares; the journey map check |
| `verify/surfaces.mjs`          | the two client surfaces the QA checks, and how a path outside them is placed |
| `verify/interaction-check.mjs` | the interaction checks as a CLI: opens each `--path` in headless Chromium at both widths and prints the findings as JSON; writes are refused unless `--allow-writes` |
| `verify/interaction-checks.mjs` | the six checks, run on one page; `interaction-check.mjs` and the journeys' screen check both run them, and the proof's scan runs its overflow, cut text and covered text |
| `verify/interaction-scan.mjs`  | the scans the checks run inside the page: cell overflow, cut and covered text, tab stops inside controls, overlays, clickable rows |
| `verify/proof-scan.mjs` | the proof's scan of each page before its shot: overflow, cut text, covered, contrast, off-token values, small targets, broken images and text, against the theme tokens the adapters' `TOKENS` modules hold |
| `watch/`                       | the `cd-watch` Worker: production probe, pages when it goes quiet (see "Watch") |
| `../infra/session/sandbox-net.sh`       | the tailnet bootstrap a Claude Code web session runs on every prompt |

## Web — Cloudflare Pages

`deploy.yml` deploys the web: its `app` part (`.github/actions/deploy-stack`) builds the
workspace packages, exports the app with `GITHUB_SHA` set to the commit it deploys, and uploads
`apps/app/dist` to the environment's Pages project (`PAGES_PROJECT`) with `wrangler pages deploy`,
under the branch name `deploy/web` for production and `deploy/web-dev` for dev. No git branch is
pushed: automatic deployments are off on both Pages projects, so a push to any branch deploys
nothing.

| Setting                | Value                                                              |
| ---------------------- | ------------------------------------------------------------------ |
| Production branch      | `deploy/web` (the branch name `deploy.yml` names on its production upload) |
| Automatic deployments  | off, production and preview                                         |
| Build variables        | the environment's GitHub variables `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_APP_WEB_URL`, read by `deploy.yml` |

Building the workspace packages before the export is not optional: without it the export dies
on a missing `@wg/config/dist/index.js`. `GITHUB_SHA` is what makes `/build.json` name the
deployed commit — and, through `apps/app/scripts/build-sha.mjs`, what bakes that same commit into
the bundle as `EXPO_PUBLIC_BUILD_SHA`, which is the build Settings → Help shows a player.

`apps/app/public/_redirects` ships `/* /index.html 200`, which is what makes
client-only routes (`/game/:id`, `/invite/:code`) survive a hard refresh; the export
copies `public/` into the output. Set `EXPO_PUBLIC_API_URL` for **both** GitHub
environments — an export with no API address falls back to `@wg/config`'s
localhost default and silently fails in the browser.

A custom domain on Pages needs nothing further; the API is a separate origin and
is reached by CORS, so `APP_WEB_URL` on the Workers must be the Pages domain. A
SECOND domain on the same project — the old one kept working after a move — goes
in `APP_WEB_URL_ALIASES`, comma separated, each a scheme and a host with no path
(https in production; the API refuses to boot on anything else and says which
entry). It widens CORS, on HTTP and the socket, and nothing else: every link, email
and OAuth redirect the API builds stays on `APP_WEB_URL`, so a sign-in started on
an alias comes back to `APP_WEB_URL`.

## Workers — Workers Builds

`deploy.yml` deploys the Workers with the Wrangler action, and nothing pushes the deploy branches any more. Workers Builds is still connected to `cd-api` and `cd-api-dev` only, never to the auth Workers, until the owner turns it off: while it is, a push to a deploy branch runs `edge-deploy.sh`, and one build deploys every Worker of its stack, `auth`, `admin` then `api`, after applying the D1 migrations.

| Setting | `cd-api` | `cd-api-dev` |
| --- | --- | --- |
| Production branch | `deploy/api` | `deploy/api-dev` |
| Deploy command | `bash infra/scripts/edge-deploy.sh --env production` | `bash infra/scripts/edge-deploy.sh --env dev` |

Both: repository `parlornights/CrookedDuke`, preview builds off, build command empty, root `/`, build cache on, variables `NODE_VERSION=22`, `PNPM_VERSION=10.33.0`, `SKIP_DEPENDENCY_INSTALL=1`, secrets `EDGE_DEPLOY_API_TOKEN` and optionally `EDGE_DEPLOY_GIT_TOKEN` (read-only, for fetching the stamped commit). Inside Workers Builds `edge-deploy.sh` refuses `--force` and `--accept-var-change`, and refuses a build of the other stack's branch.

## Google sign-in

1. Google Cloud console → APIs & Services → OAuth consent screen: External,
   app name from `APP_NAME`, support email, the app logo, and the links
   `https://play.example.com/privacy` and `/terms`. Scopes: `email`, `profile`.
2. Credentials → OAuth client ID → Web application.
   - Authorised JavaScript origins: `https://play.example.com`
   - Authorised redirect URI: `https://api.example.com/api/v1/auth/google/callback`
   - Add `http://localhost:3000/api/v1/auth/google/callback` for development.
3. Put the client id and secret in `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
   `GET /api/v1/config` only advertises Google once both are set, so the button
   never appears without a working configuration.

## Facebook sign-in

1. developers.facebook.com → Create app → "Authenticate and request data from
   users with Facebook Login" → add the **Facebook Login** product.
2. Facebook Login → Settings → Valid OAuth Redirect URIs:
   `https://api.example.com/api/v1/auth/facebook/callback` (plus the localhost
   one for development). Client OAuth login and Web OAuth login: on.
3. App settings → Basic:
   - Privacy Policy URL `https://play.example.com/privacy`
   - Terms of Service URL `https://play.example.com/terms`
   - User Data Deletion: **Data deletion callback URL**
     `https://api.example.com/api/v1/auth/facebook/data-deletion` (the app also
     serves the human-readable `https://play.example.com/data-deletion`).
   - Category, icon, and the app domain `example.com`.
4. `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET`, and `FACEBOOK_GRAPH_VERSION` if
   you pin a version other than the default (`v26.0`). The API signs every Graph
   call with `appsecret_proof`, so **Require App Secret** (App settings,
   Advanced, Security) can be on.
5. The app stays in Meta development mode until App Review; only testers can
   sign in with it, which is why §1 requires the product to be fully usable
   without Facebook. `user_friends` (the `facebookFriends` flag) needs review
   as well — leave `FEATURES_FACEBOOK_FRIENDS=false` until it is granted.

## Sign in with Apple

The owner's click list is `docs/plans/audits/providers-0925.md` §3.1 (Linear CD-84): the App ID
`com.parlornights.crookedduke`, the Services ID `com.parlornights.crookedduke.web` (dev stack:
`.dev`) with the Return URL `https://api.example.com/api/v1/auth/apple/callback`, a Sign in with
Apple key (`APPLE_KEY_ID`, the `.p8` into `APPLE_PRIVATE_KEY`, Multiline), the email sources for
the private relay, and the server-to-server endpoint
`https://api.example.com/api/v1/auth/apple/notifications`. `OAUTH_TOKEN_KEY` seals the stored
refresh tokens; losing it only means an old token cannot be revoked. `GET /api/v1/config`
advertises Apple once all five values are set; `APPLE_SERVICES_ID` is the switch. On Workers the
same names are `auth` Worker secrets (`wrangler secret put`).

## Web push (VAPID)

One key pair per deployment, generated once with `npx web-push generate-vapid-keys` and kept.
`VAPID_SUBJECT` must be a `mailto:` or `https:` URL you control. The public key is
served to the client by `GET /api/v1/config`; rotating the pair invalidates every
stored subscription, so browsers have to re-subscribe.

## Email (Resend)

1. resend.com → Domains → add `example.com`, then create the DNS records it
   shows: the DKIM `TXT` record, the SPF `TXT` (`v=spf1 include:...`) and the
   return-path `MX`. Verification takes minutes once DNS propagates.
2. API Keys → create a sending key → `RESEND_API_KEY`.
3. `MAIL_FROM` must be on the verified domain, e.g.
   `MAIL_FROM="Crooked Duke <no-reply@example.com>"`. A sending subdomain
   receives nothing, so set `MAIL_REPLY_TO` (optional, an address or
   `Name <address>`) to a mailbox that does: every email then carries it as
   Reply-To.
4. With no key the API falls back to `ConsoleMailer` and logs instead of
   sending, so a missing key is loud rather than silent. Add a DMARC record
   (`_dmarc` `TXT`, `v=DMARC1; p=none; rua=mailto:dmarc@example.com`) before
   sending in volume.

## Sandbox network (Claude Code on the web)

`../infra/session/sandbox-net.sh` is not part of a deploy: it is what gives a Claude Code
web session a route to the home server at all. Each session is a fresh VM, so
two hooks (`SessionStart` and every `UserPromptSubmit`) run the script, which
keeps a userspace `tailscaled` and its SOCKS5 port alive, logs in with
`TS_AUTHKEY` when the node is not authenticated, and writes the `wb` / `wb-root` /
`wb2` entries in `~/.ssh/config` that proxy through it. It prints at most one line and
exits 0 whatever happens. The cloud environment's setup script, the auth key's
settings, the hook JSON and what each line means are in
[`../docs/RUNBOOK.md`](../docs/RUNBOOK.md), "Sandbox network (Claude Code on the
web)".

## Watch (`watch/`, CD-203)

`cd-watch` is a Cloudflare Worker of its own (no binding to anything the game uses), on a
5-minute cron. It probes `API_HEALTH_URL` and `WEB_BUILD_URL`; two failures in a row page once,
and a recovery is said once.
A page is a Linear Urgent issue in CD (one per title while open, then
comments), plus a POST of `{"text": …}` to `PAGE_WEBHOOK_URL` when that secret is set (the owner
picks where it lands). `GET /status` shows the counters, nothing secret.

Once, by whoever deploys it:

```sh
cd infra/watch
npx wrangler kv namespace create cd-watch          # put the id in wrangler.jsonc
printf %s "$LINEAR_API_KEY" | npx wrangler secret put LINEAR_API_KEY
npx wrangler secret put PAGE_WEBHOOK_URL           # optional
npx wrangler deploy                                # after `pnpm --filter @wg/infra test`
```

## Lint is Oxlint (`.oxlintrc.json`, CD-218)

`pnpm lint` runs `oxlint .` and then `strip-comments.mjs --check`; the whole repository takes about ten seconds where ESLint took about a minute (three on Oxlint's native rules alone; the JS plugins below add the rest). The config was generated from `eslint.config.mjs` with `@oxlint/migrate`, then completed by hand where Oxlint has no native rule:

- `no-restricted-syntax` (the `DB_*` boundary, the query-cache writer, the awaited refetch, `onMutate`, the copy props, the game-token read, the boot script) runs from `oxlint-plugin-eslint`, with the same selectors, in one override per ESLint block.
- `import/order` runs from `eslint-plugin-import` as an Oxlint JS plugin (Oxlint implements none natively; its answer is `oxfmt`'s sorting). `react/no-deprecated` and `react/require-render-return` run from `eslint-plugin-react` the same way.
- `settings.react.version` is pinned by hand (Oxlint does not detect it); keep it equal to the installed React.
- `no-undef` is on for `.js`, `.mjs` and `.cjs` only, as before (TypeScript checks the rest).
- `no-dupe-args` and `no-octal` are syntax errors in modules, and `react/jsx-uses-react` and `jsx-uses-vars` are moot with the automatic JSX runtime.

`infra/lint-fixtures/cases.mjs` holds one broken source per rule and the sources that must stay clean (the permitted directories, tests); `lint-rules.test.mjs` lints them with the real config, so a rule that silently stops biting fails the infra suite. The same fixtures passed under ESLint before it was removed (CD-218, with the move to TypeScript 7, which has no compiler API for typescript-eslint). `eslint-plugin-import` and `eslint-plugin-react` stay as dependencies because the JS plugins above are theirs. `apps/app/src/api/cache/lint-guard.test.ts` runs its cases through the same Oxlint config.

TypeScript 7 (the native compiler, `tsc`) typechecks every package. It ships no importable API, so `strip-comments.mjs` takes the TypeScript 6 API from `@typescript/typescript6`, TypeScript's own compatibility package.

## Walk accounts

**The accounts (CD-278).** Three fixed emails, `walk-cf+{1,2,3}@crookedduke.com`; each password is
`base64url(HMAC-SHA256(WALK_SEED_KEY, email))` (43 characters; `live-walk-accounts.mjs`, which a
test holds equal to the e2e copy). The first two are the walk pool, the last is the smoke walk's,
which the walks never use. `WALK_SEED_KEY` (32+ characters) is set by the owner once, as a GitHub
Actions repository secret, before merging the change that brings it in: the merge starts a release,
and that release's smoke walk needs the key. The Cloudflare build does not need it. Nothing stores
a password.

- **Seeded by the release, on dev** (owner, 7 Oct: the release job seeds them, nothing else does;
  CD-285: the smoke walk runs on dev). The `release` workflow's seed step runs
  `live-walk-accounts.mjs --seed --api https://dev.crookedduke.com` with the key and the
  Cloudflare Access service token (`CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`) in that
  step's environment only: per account, in turn, one that signs in is kept; a 401 with
  `auth.invalid_credentials` is registered; a 409 `auth.email_taken` there (an account the key does
  not sign into, e.g. after a key change) is skipped and reported; any other answer (429, 5xx, a 401
  without that code, the network, 15 s per request) stops the seed. It prints emails and counts
  only, is bounded at 150 s, and has `continue-on-error`: a missing key, a skipped account or a
  stopped seed is a warning and never fails the release; the smoke walk on dev then judges the
  account (exit 2 no key, a failed sign-in), before production moves. The smoke walk's account is
  seeded first.
- **Seeded on production** (CD-372). `deploy-part.yml`'s seed runs in the api and app parts of a
  production deploy too (the release PR's merge calls `deploy.yml` for production), against
  production's API with the key alone (production sits behind no Access, so no `CF_ACCESS_*`
  reaches it), with the same rules, log and bound and `continue-on-error`.
- **After a key change.** The accounts still hold passwords derived from the old key, so each seed
  gets 409 `auth.email_taken` for it and skips it, and the smoke walk on dev fails its sign-in (dev
  rolls back, production never moves). To recover, a person deletes `walk-cf+{1,2,3}@crookedduke.com`
  in the admin, on dev and on production (Players, the player's page, "Delete the account", with a reason); no script
  deletes them. The next release then seeds all three on dev with the new key, and the next
  production deploy seeds them on production.
- **The release's smoke walk** (`smoke-walk.mjs --env dev`, after `release.yml`'s deploy to dev) signs in as
  the last account; `release.yml` passes it the `WALK_SEED_KEY` secret and the Access token. No key
  is exit 2. It retries its new bot game once on a 429 whose retry-after is at most 5 s (a limiter
  that cannot answer) and prints every 429's retry-after and attempt; a longer wait (a real ceiling)
  fails the walk. Production's check after its deploy is `smoke-walk.mjs --quick` (health and web
  builds, no account).
