# Milestone M3f — `@paraharness/github`, `@paraharness/slack`, `@paraharness/stripe` & `@paraharness/netsuite` Connector Adapters

## 1. Scope & Ownership (`owned_dirs` & `forbidden_dirs`)

- **Milestone**: `M3f` (Wave 2 — Parallel Adapter Fan-Out `c`, depends on `M1`)
- **Packages**: `@paraharness/github` (`packages/github`), `@paraharness/slack` (`packages/slack`), `@paraharness/stripe` (`packages/stripe`), and `@paraharness/netsuite` (`packages/netsuite`)
- **`owned_dirs`**:
  - `packages/github/src/**`, `packages/github/test/**`
  - `packages/slack/src/**`, `packages/slack/test/**`
  - `packages/stripe/src/**`, `packages/stripe/test/**`
  - `packages/netsuite/src/**`, `packages/netsuite/test/**`
- **`forbidden_dirs`**:
  - `packages/core/**`, `packages/lockfile/**`
  - `packages/{sqlite,postgres,fs,markdown,node,git,claude,openai,gemini,integration}/**`
  - Root workspace configs (`package.json`, `eslint.config.mjs`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`) and `docs/**`
- **Cross-Adapter Independence Rule**:
  - `@paraharness/github`, `@paraharness/slack`, `@paraharness/stripe`, and `@paraharness/netsuite` must have **zero runtime or type imports** from each other or from any other M3 adapter package. `@paraharness/github` depends exclusively on `@paraharness/core` (`workspace:*`), `@octokit/rest`, `@octokit/webhooks`, `zod`, and Node built-ins; `@paraharness/slack` depends exclusively on `@paraharness/core` (`workspace:*`), `@slack/web-api`, `@slack/socket-mode`, `@slack/webhook`, `zod`, and Node built-ins; `@paraharness/stripe` depends exclusively on `@paraharness/core` (`workspace:*`), `stripe`, `zod`, and Node built-ins; `@paraharness/netsuite` depends exclusively on `@paraharness/core` (`workspace:*`), `big.js`, `zod`, and Node built-ins.

### Approved External Libraries & Native Primitives (`CLAUDE.MD` #2 & `docs/CODING_GUIDELINES.md` Rule 3.5)

| Concern | Selected Package / Built-in | Version & License | Evaluated Alternatives & Rejection Reason | Lifecycle & Native/WASM Trade-offs | Owner Approval Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| GitHub REST API client (`github.issues`, `github.createOrUpdatePr`) | `@octokit/rest` | `^22.0.1` (npm `22.0.1`, `MIT`, `0` deprecated, `0` CVEs) | Full `octokit` meta-package (pulls unnecessary GraphQL/App sub-packages), hand-rolled `fetch` client (forbidden by Rule 3.5) | Official modular GitHub REST client; supports injectable `GithubHttpTransport` / `request.fetch` test seam | Approved (`Rule 3.5`) |
| GitHub Webhook HMAC-SHA256 signature verification & event dispatch (`github.webhookStream`) | `@octokit/webhooks` (`Webhooks`) | `^14.2.0` (npm `14.2.0`, `MIT`, `0` deprecated, `0` CVEs) | Hand-rolled `crypto.createHmac` header parser (forbidden by Rule 3.5) | Constant-time `X-Hub-Signature-256` verification and typed event payload handling; close HTTP listener in `try / finally` | Approved (`Rule 3.5`) |
| Slack Web API, Socket Mode & Incoming Webhook clients (`slack.bot`, `slack.webhook`) | `@slack/web-api` (`^8.3.0`), `@slack/socket-mode` (`^3.1.1`), `@slack/webhook` (`^8.0.2`) | `MIT` (npm `8.3.0`, `3.1.1`, `8.0.2`, `0` deprecated, `0` CVEs) | `@slack/bolt` (heavy HTTP framework wrapper), hand-rolled Slack HTTP/WebSocket client (forbidden by Rule 3.5) | Official Slack SDKs; memoize `SlackApproverAdapter` per `(RuntimeDriverContext, canonicalNodeKey)` via `WeakMap` across `humanChannels` and `controlPlanes` (`docs/lessons/BUILDER.md`) and clear keep-alive timers in `try / finally` | Approved (`Rule 3.5`) |
| Stripe API client & financial types (`stripe.readTools`, `stripe.maxRefundGuardUsd`, `stripe.allowRefundUpToUsd`) | `stripe` | `^23.1.0` (npm `23.1.0`, `MIT`, `0` deprecated, `0` CVEs) | Hand-rolled Stripe REST wrapper (forbidden by Rule 3.5) | Official Stripe TypeScript SDK with injectable HTTP client / transport seam for offline deterministic testing | Approved (`Rule 3.5`) |
| Exact arbitrary-precision decimal arithmetic (`netsuite.balanceZeroCheck`, journal debit/credit summation) | `big.js` (`+ @types/big.js`) | `^7.0.1` (npm `7.0.1`, `MIT`, `0` deprecated, `0` CVEs) | Native IEEE-754 `number` (`0.1 + 0.2 !== 0.3` floating-point drift on financial journal lines, forbidden by Rule 3.5), `decimal.js` (heavier trig/transcendental surface unnecessary for financial ledger arithmetic) | Pure JS exact decimal arithmetic (`new Big(line.debitUsd).minus(line.creditUsd)`) with zero floating-point rounding error | Approved (`Rule 3.5`) |
| Schema validation (`responseSchema`, tool/step payloads) | `zod` | `^4.6.7` (npm `4.6.7`, `MIT`, `0` deprecated, `0` CVEs) | Hand-rolled validation (forbidden by Rule 3.5) | Pure TypeScript runtime validation | Approved (`Rule 3.5`) |

---

## 2. Normative Specification & Coding Sample Grounding

| Normative Source | Section & Exact Line Range | Grounded Scope in `M3f` |
| :--- | :--- | :--- |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §1.1–§1.2 (`lines 3–34`) | Pure passive AST nodes (`GithubIssuesTrackerNode`, `GithubWebhookStreamNode`, `GithubCreateOrUpdatePrNode`, `SlackApproverNode`, `SlackNotifierNode`, `StripeReadToolNode`, `StripeMaxRefundGuardNode`, `StripeMaxRefundMatcherNode`, `NetSuiteDraftScopeNode`, `NetSuiteClosedPeriodGuardNode`, `NetSuiteJournalToolNode`, `NetSuiteBalanceZeroCheckNode`, `NetSuiteRollbackAbortHookNode`), namespaced `CustomDomainASTRegistry` declaration merging (`'tool:stripe'`, `'guard:stripe'`, `'effectMatcher:stripe'`, `'scope:netsuite'`, `'guard:netsuite'`, `'abortHook:netsuite'`, `'tool:netsuite'`, `'check:netsuite'`), and late-bound `EnvRef` resolution via `ctx.resolveEnv`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.2–§2.5 & §2.8 (`lines 682–1522`, `2106–2140`) | `BaseTrackerASTNode`, `BaseStreamSourceASTNode`, `BaseDomainStepASTNode`, `BaseHumanChannelASTNode` (`interactionMode: 'bidirectional' \| 'notify-only'`), `BaseControlPlaneASTNode`, `BaseIsolationScopeASTNode` (`capabilityTier: 'scope'`), `BaseToolASTNode` (`effectTracking: 'declared'`), `BasePolicyGuardASTNode`, `BaseCheckASTNode`, `BaseAbortHookASTNode`, `IsolationScope`, `TrackerAdapter`, `StreamSource`, `HumanAdapter`, `ControlPlaneAdapter`, `RuntimeExecutorRegistrySlice`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §4.5 (`lines 3153–3196`) | `@paraharness/github` (`github.issues(opts)`, `github.webhookStream(opts)` defaulting `port` to `3000` and `path` to `'/webhooks/github'`, `github.createOrUpdatePr(id, opts)`) and `@paraharness/slack` (`slack.webhook(url)` with `interactionMode: 'notify-only'`, `slack.bot(opts)` with `interactionMode: 'bidirectional'` implementing `HumanAdapter` & `ControlPlaneAdapter`). |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §5 (`lines 3199–3341`) | Non-coding financial harness domain adapters `@paraharness/stripe` (`stripe.readTools()`, `stripe.maxRefundGuardUsd(limit)`, `stripe.allowRefundUpToUsd(limit)`) and `@paraharness/netsuite` (`netsuite.draftJournalScope()` with `capabilityTier: 'scope'`, `netsuite.forbidClosedPeriodPosting()`, `netsuite.journalTools()`, `netsuite.balanceZeroCheck()`, `netsuite.rollbackDraftJournal()`). |
| [`docs/CODING_SAMPLE.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_SAMPLE.md) | §6 (`lines 183, 186, 356–365, 431–452, 1132–1169, 1206`) | `slack.bot(...)`, `github.webhookStream(...)`, `github.issues(...)` in `engineering-harness.ts`. |

---

## 3. Planned Module Decomposition & Public Exports

Every file, class, method, and function in `packages/{github,slack,stripe,netsuite}/src/**` and `test/fixtures/**` adheres to [`docs/CODING_GUIDELINES.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_GUIDELINES.md) §§1–5: each file, class, method, and function has **one clear responsibility at one uniform level of abstraction** (Rules 1.1–1.8 & 3.1–3.4), single-kind entity files per Rule 1.1, 1 root `interface` per file plus reachable `TSPropertySignature` / `TSMethodSignature` sub-interfaces per Rule 1.2, 1 `class` per file with optional co-located dedicated 1:1 `*Params`/`*Options` interfaces per Rule 1.3, 1 builder factory function per `create-*.ts` file with optional co-located dedicated 1:1 `*Params`/`*Options` interfaces per Rules 1.6 & 3.3, pure `src/index.ts` barrels, complete `/** ... */` JSDoc on every declaration per Rules 2.1–2.3, and zero inline/non-JSDoc comments per Rule 2.4. Orchestrators and connector adapters only sequence high-level phase calls and lifecycle boundaries (`try / finally`), delegating webhook signature verification, Slack Socket Mode decision routing, Stripe guard evaluation, and NetSuite `big.js` decimal balance checks to focused `internal/` functions. Builders are free and expected to extract additional focused `internal/` phase, predicate, and projection helper files beyond the baseline §3 tables whenever responsibilities separate, while preserving all planned public exports.

### 3.1 `packages/github` (`@paraharness/github`)

| File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `src/builders/github-create-or-update-pr-builder.ts` | `interface` | `GithubCreateOrUpdatePrBuilder<TIn, TOut, THandle>` (plus `TSMethodSignature` sub-interface `GithubCreateOrUpdatePrOptions<TIn>`) |
| `src/builders/create-github-issues-builder.ts` | `function` | `createGithubIssuesBuilder` |
| `src/builders/create-github-webhook-stream-builder.ts` | `function` | `createGithubWebhookStreamBuilder` |
| `src/builders/create-github-create-or-update-pr-builder.ts` | `function` | `createGithubCreateOrUpdatePrBuilder` |
| `src/builders/github-namespace-contract.ts` | `interface` | `GithubNamespace` (plus `TSMethodSignature` sub-interfaces `GithubIssuesOptions`, `GithubWebhookStreamOptions`) |
| `src/builders/github-namespace.ts` | `const` | `github: GithubNamespace` |
| `src/executors/github-issue-record.ts` | `interface` | `GithubIssueRecord` |
| `src/executors/github-http-transport.ts` | `interface` | `GithubHttpTransport` |
| `src/executors/default-github-http-transport.constants.ts` | `const` | `defaultGithubHttpTransport: GithubHttpTransport` (backed by `@octokit/rest`) |
| `src/executors/github-issues-tracker.ts` | `class` | `GithubIssuesTrackerAdapter` (implementing `TrackerAdapter<GithubIssueRecord, string>`) |
| `src/executors/github-webhook-stream.ts` | `class` | `GithubWebhookStreamSource` (implementing `StreamSource<unknown>` with `@octokit/webhooks` HMAC-SHA256 `X-Hub-Signature-256` verification) |
| `src/executors/github-pr-step-executor.ts` | `function` | `executeGithubCreateOrUpdatePrStep` |
| `src/executors/create-github-executors.ts` | `function` | `createGithubExecutors` |
| `src/executors/github-executors.constants.ts` | `const` | `githubExecutors: RuntimeExecutorRegistrySlice` |
| `src/index.ts` | `barrel` | Pure explicit re-exports of `github`, `GithubNamespace`, `githubExecutors`, `createGithubExecutors`, `GithubIssuesTrackerAdapter`, `GithubWebhookStreamSource`, `GithubHttpTransport`, `defaultGithubHttpTransport`, `GithubIssueRecord`, `GithubCreateOrUpdatePrBuilder`, `GithubIssuesOptions`, `GithubWebhookStreamOptions`, `GithubCreateOrUpdatePrOptions`, `createGithubIssuesBuilder`, `createGithubWebhookStreamBuilder`, `createGithubCreateOrUpdatePrBuilder`, `GithubIssuesTrackerNode`, `GithubWebhookStreamNode`, `GithubCreateOrUpdatePrNode` |
| `test/github-adapter.test.ts` | `test` | Deterministic unit tests for `github.issues`, `github.webhookStream`, and `github.createOrUpdatePr` |
| `test/github-webhook-and-pagination.test.ts` | `test` | Deterministic unit tests for multi-page `github.issues` pagination, PR filtering, `@octokit/webhooks` verification, HTTP `413`/`500` handling, premature stream close listener cleanup, and duplicate `subscribe()` rejection |

### 3.2 `packages/slack` (`@paraharness/slack`)

| File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `src/builders/create-slack-bot-builder.ts` | `function` | `createSlackBotBuilder` |
| `src/builders/create-slack-webhook-builder.ts` | `function` | `createSlackWebhookBuilder` |
| `src/builders/slack-namespace-contract.ts` | `interface` | `SlackNamespace` (plus `TSMethodSignature` sub-interface `SlackBotOptions`) |
| `src/builders/slack-namespace.ts` | `const` | `slack: SlackNamespace` |
| `src/executors/slack-transport.ts` | `interface` | `SlackTransport` |
| `src/executors/default-slack-transport.constants.ts` | `const` | `defaultSlackTransport: SlackTransport` (backed by `@slack/web-api`, `@slack/socket-mode`, and `@slack/webhook`) |
| `src/executors/slack-approver-adapter.ts` | `class` | `SlackApproverAdapter` (implementing `HumanAdapter` and `ControlPlaneAdapter`) |
| `src/executors/slack-notifier-adapter.ts` | `class` | `SlackNotifierAdapter` (implementing `HumanAdapter` for `'notify-only'`) |
| `src/executors/create-slack-executors.ts` | `function` | `createSlackExecutors` (memoizing `SlackApproverAdapter` per `(RuntimeDriverContext, canonicalNodeKey)` via `WeakMap` across `humanChannels` and `controlPlanes`) |
| `src/executors/slack-executors.constants.ts` | `const` | `slackExecutors: RuntimeExecutorRegistrySlice` |
| `src/index.ts` | `barrel` | Pure explicit re-exports of `slack`, `SlackNamespace`, `slackExecutors`, `createSlackExecutors`, `SlackApproverAdapter`, `SlackNotifierAdapter`, `SlackTransport`, `defaultSlackTransport`, `SlackBotOptions`, `createSlackBotBuilder`, `createSlackWebhookBuilder`, `SlackApproverNode`, `SlackNotifierNode` |

### 3.3 `packages/stripe` (`@paraharness/stripe`) & `packages/netsuite` (`@paraharness/netsuite`)

| Package & File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `packages/stripe/src/nodes/stripe-read-tool-node.ts` | `interface` | `StripeReadToolNode` |
| `packages/stripe/src/nodes/stripe-max-refund-guard-node.ts` | `interface` | `StripeMaxRefundGuardNode` |
| `packages/stripe/src/nodes/stripe-max-refund-matcher-node.ts` | `interface` | `StripeMaxRefundMatcherNode` |
| `packages/stripe/src/nodes/stripe-registry-augmentation.ts` | `interface` | `declare module '@paraharness/core'` augmenting `CustomDomainASTRegistry` with `'tool:stripe'`, `'guard:stripe'`, `'effectMatcher:stripe'` |
| `packages/stripe/src/builders/create-stripe-read-tools.ts` | `function` | `createStripeReadTools` |
| `packages/stripe/src/builders/create-stripe-max-refund-guard-builder.ts` | `function` | `createStripeMaxRefundGuardBuilder` |
| `packages/stripe/src/builders/create-stripe-allow-refund-lease-delta.ts` | `function` | `createStripeAllowRefundLeaseDelta` |
| `packages/stripe/src/builders/stripe-namespace-contract.ts` | `interface` | `StripeNamespace` (`readTools`, `maxRefundGuardUsd`, `allowRefundUpToUsd`) |
| `packages/stripe/src/builders/stripe-namespace.ts` | `const` | `stripe: StripeNamespace` |
| `packages/stripe/src/executors/create-stripe-executors.ts` | `function` | `createStripeExecutors` (backed by `stripe` SDK) |
| `packages/stripe/src/executors/stripe-executors.constants.ts` | `const` | `stripeExecutors: RuntimeExecutorRegistrySlice` |
| `packages/stripe/src/index.ts` | `barrel` | Pure explicit re-exports of `stripe`, `StripeNamespace`, `stripeExecutors`, `createStripeExecutors`, `createStripeReadTools`, `createStripeMaxRefundGuardBuilder`, `createStripeAllowRefundLeaseDelta`, `StripeReadToolNode`, `StripeMaxRefundGuardNode`, `StripeMaxRefundMatcherNode` |
| `packages/netsuite/src/nodes/netsuite-draft-handle.ts` | `interface` | `NetSuiteDraftHandle` |
| `packages/netsuite/src/nodes/draft-journal-receipt.ts` | `interface` | `DraftJournalReceipt` |
| `packages/netsuite/src/nodes/netsuite-draft-scope-node.ts` | `interface` | `NetSuiteDraftScopeNode` |
| `packages/netsuite/src/nodes/netsuite-closed-period-guard-node.ts` | `interface` | `NetSuiteClosedPeriodGuardNode` |
| `packages/netsuite/src/nodes/netsuite-journal-tool-node.ts` | `interface` | `NetSuiteJournalToolNode` |
| `packages/netsuite/src/nodes/netsuite-balance-zero-check-node.ts` | `interface` | `NetSuiteBalanceZeroCheckNode` |
| `packages/netsuite/src/nodes/netsuite-rollback-abort-hook-node.ts` | `interface` | `NetSuiteRollbackAbortHookNode` |
| `packages/netsuite/src/nodes/netsuite-registry-augmentation.ts` | `interface` | `declare module '@paraharness/core'` augmenting `CustomDomainASTRegistry` with `'scope:netsuite'`, `'guard:netsuite'`, `'abortHook:netsuite'`, `'tool:netsuite'`, `'check:netsuite'` |
| `packages/netsuite/src/builders/create-netsuite-draft-journal-scope-builder.ts` | `function` | `createNetSuiteDraftJournalScopeBuilder` |
| `packages/netsuite/src/builders/create-netsuite-closed-period-guard-builder.ts` | `function` | `createNetSuiteClosedPeriodGuardBuilder` |
| `packages/netsuite/src/builders/create-netsuite-journal-tools.ts` | `function` | `createNetSuiteJournalTools` |
| `packages/netsuite/src/builders/create-netsuite-balance-zero-check-builder.ts` | `function` | `createNetSuiteBalanceZeroCheckBuilder` |
| `packages/netsuite/src/builders/create-netsuite-rollback-abort-hook-builder.ts` | `function` | `createNetSuiteRollbackAbortHookBuilder` |
| `packages/netsuite/src/builders/netsuite-namespace-contract.ts` | `interface` | `NetSuiteNamespace` (`draftJournalScope`, `forbidClosedPeriodPosting`, `journalTools`, `balanceZeroCheck`, `rollbackDraftJournal`) |
| `packages/netsuite/src/builders/netsuite-namespace.ts` | `const` | `netsuite: NetSuiteNamespace` |
| `packages/netsuite/src/executors/netsuite-draft-scope-driver.ts` | `class` | `NetSuiteDraftScopeDriver` (implementing Tier-1 `IsolationScope<NetSuiteDraftHandle, DraftJournalReceipt>`) |
| `packages/netsuite/src/executors/create-netsuite-executors.ts` | `function` | `createNetSuiteExecutors` (using `big.js` for exact decimal balance verification) |
| `packages/netsuite/src/executors/netsuite-executors.constants.ts` | `const` | `netsuiteExecutors: RuntimeExecutorRegistrySlice` |
| `packages/netsuite/src/index.ts` | `barrel` | Pure explicit re-exports of `netsuite`, `NetSuiteNamespace`, `netsuiteExecutors`, `createNetSuiteExecutors`, `NetSuiteDraftScopeDriver`, `createNetSuiteDraftJournalScopeBuilder`, `createNetSuiteClosedPeriodGuardBuilder`, `createNetSuiteJournalTools`, `createNetSuiteBalanceZeroCheckBuilder`, `createNetSuiteRollbackAbortHookBuilder`, `NetSuiteDraftHandle`, `DraftJournalReceipt`, `NetSuiteDraftScopeNode`, `NetSuiteClosedPeriodGuardNode`, `NetSuiteJournalToolNode`, `NetSuiteBalanceZeroCheckNode`, `NetSuiteRollbackAbortHookNode` |

---

## 4. Detailed Implementation Requirements

### 4.0 Single-Kind File Separation, Co-Location & JSDoc Discipline (`docs/CODING_GUIDELINES.md` §§1–3)
1. **Single-Responsibility Decomposition, Single-Kind Entity Files & Co-Location (`Rules 1.1–1.8 & 3.1–3.4`)**:
   - Every file, class, method, and function in `packages/{github,slack,stripe,netsuite}/src/**` and `packages/{github,slack,stripe,netsuite}/test/fixtures/**` must have **one clear responsibility at one uniform level of abstraction** (`docs/CODING_GUIDELINES.md` §§1–3). Orchestrators and connector adapters only sequence high-level phase calls and lifecycle boundaries (`try / finally`), delegating context extraction, state initialization, lesson recall/scoring, iteration phases, and outcome projection to focused `internal/` functions. Builders are free and expected to extract additional focused `internal/` phase, predicate, and projection helper files beyond the baseline §3 table whenever responsibilities separate, while preserving all planned public exports.
   - Unrelated or different-kind declarations (`interface`, `function`, `class`, `const`, `type`) must **never** live in the same file in `packages/{github,slack,stripe,netsuite}/src/**` or `packages/{github,slack,stripe,netsuite}/test/fixtures/**`.
   - Every domain AST node interface (`StripeReadToolNode`, `StripeMaxRefundGuardNode`, `StripeMaxRefundMatcherNode`, `NetSuiteDraftHandle`, `DraftJournalReceipt`, `NetSuiteDraftScopeNode`, `NetSuiteClosedPeriodGuardNode`, `NetSuiteJournalToolNode`, `NetSuiteBalanceZeroCheckNode`, `NetSuiteRollbackAbortHookNode`), every root builder/transport interface, and every namespace contract (`*-namespace-contract.ts`) lives in its own single-interface file, co-locating secondary interfaces reachable via `TSPropertySignature` or `TSMethodSignature` parameter/return types (`GithubIssuesOptions`, `GithubWebhookStreamOptions`, `GithubCreateOrUpdatePrOptions<TIn>`, `SlackBotOptions`) per Rule 1.2.
   - Every builder factory function (`create-*.ts`) gets its own focused file (`Rule 1.6`); every adapter class (`GithubIssuesTrackerAdapter`, `GithubWebhookStreamSource`, `SlackApproverAdapter`, `SlackNotifierAdapter`, `NetSuiteDraftScopeDriver`) gets its own single-class file; every `const` (`github`, `slack`, `stripe`, `netsuite`, `default*Transport`, `*Executors`) lives in its own `const`-only file.
2. **JSDoc Anatomy & Official Vendor SDK Mandate (`docs/CODING_GUIDELINES.md` §2 & Rule 3.5)**:
   - Use the official vendor SDKs and libraries installed in each package (`@octokit/rest` + `@octokit/webhooks` in `@paraharness/github`, `@slack/web-api` + `@slack/socket-mode` + `@slack/webhook` in `@paraharness/slack`, `stripe` in `@paraharness/stripe`, and `big.js` for exact decimal balance verification in `@paraharness/netsuite`).
   - Every `class` (and its constructor, methods, and properties), `interface` (and its properties and methods), `function` (public and `internal/`), and top-level `type` alias or `const` in `src/**` and `test/fixtures/**` must carry a complete `/** ... */` JSDoc block per `docs/CODING_GUIDELINES.md` §2 (clear summary sentence, behavioral description when non-obvious, and complete `@template`, `@param {Type} name - Description`, `@returns {Type} Description`, and `@throws` / `@note` / `@example` tags where applicable, with zero inline or body comments), enforced by `pnpm --filter @paraharness/github --filter @paraharness/slack --filter @paraharness/stripe --filter @paraharness/netsuite lint`.

### 4.1 `@paraharness/github` (`SPEC.md` §4.5 line 3177 & `CODING_SAMPLE.md` lines 431–452, 1132–1169)
1. **`github.issues({ repo, token, labels? })`**:
   - Compiles to `GithubIssuesTrackerNode` (`readonly type: 'github:issues'`).
   - `GithubIssuesTrackerAdapter` (`trackers['github:issues']`) implements `poll()` (fetching issues from `/repos/${repo}/issues` with resolved `token`) and `setExternalState(itemKey, state)` (updating issue labels on `/repos/${repo}/issues/${issueNumber}/labels`).
2. **`github.webhookStream({ repo?, port?, path?, secret, events })`**:
   - Compiles to `GithubWebhookStreamNode` (`readonly type: 'github:webhook-stream'`, defaulting `port` to `3000` and `path` to `'/webhooks/github'`).
   - `GithubWebhookStreamSource` (`streamSources['github:webhook-stream']`) verifies HMAC-SHA256 (`X-Hub-Signature-256`) using resolved `secret`, filters by `X-GitHub-Event` / `payload.action` against `node.events` and `payload.repository.full_name` against `node.repo`, and invokes `onEvent(payload)`.
3. **`github.createOrUpdatePr(id, { repo, token, branch, baseBranch?, title, body })`**:
   - Compiles to `GithubCreateOrUpdatePrNode` (`readonly type: 'github:create-or-update-pr'`, supporting `.input(schema)` and `.output(schema)`).
   - Step executor queries open PRs for `head: branch(input)` and creates or updates the PR on `/repos/${repo}/pulls`.

### 4.2 `@paraharness/slack` (`SPEC.md` §4.5 line 3178 & `CODING_SAMPLE.md` lines 356–365, 1197–1206)
1. **`slack.bot({ appToken, botToken, channel })`**:
   - Compiles to `SlackApproverNode` (`readonly type: 'slack:approver'`, `readonly interactionMode: 'bidirectional'`).
   - `SlackApproverAdapter` (`humanChannels['slack:approver']` & `controlPlanes['slack:approver']`):
     - `notify(message)`: posts to `channel` via `chat.postMessage`.
     - `requestDecision(req)`: posts interactive decision block keyed by `(req.runId, req.requestId)`, emits periodic keep-alive heartbeat pings when `req.keepAliveSeconds` is configured, validates the human's response against `req.responseSchema`, and cleans up on `req.signal` abort.
     - `cancelDecision(runId, requestId)`: updates the Slack message to mark it superseded/cancelled and rejects/clears the pending promise (`SPEC.md` §3.6 & §3.7.2).
     - `start(controller)`: connects Socket Mode control plane allowing external signals (`controller.emitSignal`) and active-run queries (`controller.getActiveRuns`).
2. **`slack.webhook(url)`**:
   - Compiles to `SlackNotifierNode` (`readonly type: 'slack:notifier'`, `readonly interactionMode: 'notify-only'`).
   - `SlackNotifierAdapter` implements `notify(message)` and throws an actionable error if `requestDecision` is ever called on a `'notify-only'` channel.

### 4.3 `@paraharness/stripe` & `@paraharness/netsuite` (`SPEC.md` §5 lines 3182–3324)
- Implement the exact Tier-1 (`capabilityTier: 'scope'`) scope, tools (`effectTracking: 'declared'`), policy guards (`forbidClosedPeriodPosting`, `maxRefundGuardUsd(500)`), lease delta (`allowRefundUpToUsd(10_000)` with `grantedMatchers: [{ type: 'stripe:max-refund-matcher', id, maxRefundUsd }]`), check (`balanceZeroCheck`), and abort hook (`rollbackDraftJournal`) specified in `SPEC.md` §5 so the non-coding financial harness compiles and executes end-to-end without git semantics.
- **Collision-Free `CustomDomainASTRegistry` Augmentation**:
  - `packages/stripe` augments `CustomDomainASTRegistry` with namespaced keys `'tool:stripe': StripeReadToolNode; 'guard:stripe': StripeMaxRefundGuardNode; 'effectMatcher:stripe': StripeMaxRefundMatcherNode;`.
  - `packages/netsuite` augments `CustomDomainASTRegistry` with namespaced keys `'scope:netsuite': NetSuiteDraftScopeNode; 'guard:netsuite': NetSuiteClosedPeriodGuardNode; 'abortHook:netsuite': NetSuiteRollbackAbortHookNode; 'tool:netsuite': NetSuiteJournalToolNode; 'check:netsuite': NetSuiteBalanceZeroCheckNode;` so both packages compile independently and together without `TS2717` property type collisions.

---

## 5. Deterministic Test Suite Architecture (`test/**` & `test/fixtures/**`)

| File Path | Primary Category | Required Deterministic Test Cases |
| :--- | :--- | :--- |
| `packages/github/test/github-adapter.test.ts` | `test` | Verifies `github.issues`, `github.webhookStream` (default `port: 3000`, `path: '/webhooks/github'`, HMAC-SHA256 verification, event & repo filtering), and `github.createOrUpdatePr` using a deterministic recorded transport / local HTTP webhook test client. |
| `packages/github/test/github-webhook-and-pagination.test.ts` | `test` | Verifies 100-item page pagination and `pull_request` entry filtering in `GithubIssuesTrackerAdapter.poll()`, `@octokit/webhooks` HMAC-SHA256 signature verification, HTTP `413` oversized payload rejection, HTTP `500` response when `onEvent` rejects, stream listener detachment on premature request close, and duplicate `subscribe()` rejection. |
| `packages/slack/test/slack-adapter.test.ts` | `test` | Verifies `slack.bot` (`interactionMode: 'bidirectional'`, `notify`, `requestDecision` with schema validation and keep-alive heartbeats, `cancelDecision` superseding active requests, `start(controller)` control-plane signal emission) and `slack.webhook` (`interactionMode: 'notify-only'`). |
| `packages/stripe/test/stripe-adapter.test.ts` | `test` | Verifies `stripe.readTools()`, `stripe.maxRefundGuardUsd(500)` pre-flight `ToolEffect` evaluation, `stripe.allowRefundUpToUsd(10_000)` `LeaseDelta` matcher elevation (`grantedMatchers`), and `'tool:stripe'` / `'guard:stripe'` / `'effectMatcher:stripe'` `CustomDomainAST` resolution. |
| `packages/netsuite/test/netsuite-adapter.test.ts` | `test` | Verifies `netsuite.draftJournalScope()` Tier-1 `IsolationScope` (`capabilityTier: 'scope'`, `acquireRoot`, `reattachRoot`, `inspect`, `release`), `netsuite.forbidClosedPeriodPosting()`, `netsuite.journalTools()`, `netsuite.balanceZeroCheck()`, `netsuite.rollbackDraftJournal()`, and `'scope:netsuite'` / `'guard:netsuite'` / `'abortHook:netsuite'` / `'tool:netsuite'` / `'check:netsuite'` `CustomDomainAST` resolution. |

---

## 6. Verification Gate Commands

Run from workspace root (plus the `IMPL_LOOP.md` `baseline_dirty` diff check against `<non_sibling_forbidden_dirs_excluding_upstream_patches>`):

```bash
pnpm --filter @paraharness/github --filter @paraharness/slack --filter @paraharness/stripe --filter @paraharness/netsuite lint
pnpm --filter @paraharness/github --filter @paraharness/slack --filter @paraharness/stripe --filter @paraharness/netsuite typecheck
pnpm --filter @paraharness/github --filter @paraharness/slack --filter @paraharness/stripe --filter @paraharness/netsuite test -- --reporter=verbose
test -z "$(git status --porcelain -- docs .agents .claude package.json tsconfig.base.json vitest.config.ts)"
```
