# Milestone M3f — `@harness-dsl/github`, `@harness-dsl/slack`, `@harness-dsl/stripe` & `@harness-dsl/netsuite` Connector Adapters

## 1. Scope & Ownership (`owned_dirs` & `forbidden_dirs`)

- **Milestone**: `M3f` (Wave 2 — Parallel Adapter Fan-Out `c`, depends on `M1`)
- **Packages**: `@harness-dsl/github` (`packages/github`), `@harness-dsl/slack` (`packages/slack`), `@harness-dsl/stripe` (`packages/stripe`), and `@harness-dsl/netsuite` (`packages/netsuite`)
- **`owned_dirs`**:
  - `packages/github/src/**`, `packages/github/test/**`
  - `packages/slack/src/**`, `packages/slack/test/**`
  - `packages/stripe/src/**`, `packages/stripe/test/**`
  - `packages/netsuite/src/**`, `packages/netsuite/test/**`
- **`forbidden_dirs`**:
  - `packages/core/**`
  - `packages/{sqlite,postgres,fs,markdown,node,git,claude,openai,gemini,integration}/**`
  - Root workspace configs (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`) and `docs/**`
- **Cross-Adapter Independence Rule**:
  - `@harness-dsl/github`, `@harness-dsl/slack`, `@harness-dsl/stripe`, and `@harness-dsl/netsuite` must have **zero runtime or type imports** from each other or from any other M3 adapter package. Each depends exclusively on `@harness-dsl/core` (`workspace:*`), `zod`, and Node built-ins (`node:http`, `node:crypto`).

---

## 2. Normative Specification & Coding Sample Grounding

| Normative Source | Section & Exact Line Range | Grounded Scope in `M3f` |
| :--- | :--- | :--- |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §1.1–§1.2 (`lines 3–34`) | Pure passive AST nodes (`GithubIssuesTrackerNode`, `GithubWebhookStreamNode`, `GithubCreateOrUpdatePrNode`, `SlackApproverNode`, `SlackNotifierNode`, `StripeReadToolNode`, `StripeMaxRefundGuardNode`, `NetSuiteDraftScopeNode`, `NetSuiteClosedPeriodGuardNode`, `NetSuiteJournalToolNode`, `NetSuiteBalanceZeroCheckNode`, `NetSuiteRollbackAbortHookNode`), `CustomDomainASTRegistry` declaration merging, and late-bound `EnvRef` resolution via `ctx.resolveEnv`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.2–§2.5 & §2.8 (`lines 682–1505`, `2089–2123`) | `BaseTrackerASTNode`, `BaseStreamSourceASTNode`, `BaseDomainStepASTNode`, `BaseHumanChannelASTNode` (`interactionMode: 'bidirectional' \| 'notify-only'`), `BaseControlPlaneASTNode`, `BaseIsolationScopeASTNode` (`capabilityTier: 'scope'`), `BaseToolASTNode` (`effectTracking: 'declared'`), `BasePolicyGuardASTNode`, `BaseCheckASTNode`, `BaseAbortHookASTNode`, `IsolationScope`, `TrackerAdapter`, `StreamSource`, `HumanAdapter`, `ControlPlaneAdapter`, `RuntimeExecutorRegistrySlice`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §4.5 (`lines 3136–3179`) | `@harness-dsl/github` (`github.issues(opts)`, `github.webhookStream(opts)` defaulting `port` to `3000` and `path` to `'/webhooks/github'`, `github.createOrUpdatePr(id, opts)`) and `@harness-dsl/slack` (`slack.webhook(url)` with `interactionMode: 'notify-only'`, `slack.bot(opts)` with `interactionMode: 'bidirectional'` implementing `HumanAdapter` & `ControlPlaneAdapter`). |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §5 (`lines 3182–3324`) | Non-coding financial harness domain adapters `@harness-dsl/stripe` (`stripe.readTools()`, `stripe.maxRefundGuardUsd(limit)`, `stripe.allowRefundUpToUsd(limit)`) and `@harness-dsl/netsuite` (`netsuite.draftJournalScope()` with `capabilityTier: 'scope'`, `netsuite.forbidClosedPeriodPosting()`, `netsuite.journalTools()`, `netsuite.balanceZeroCheck()`, `netsuite.rollbackDraftJournal()`). |
| [`docs/CODING_SAMPLE.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_SAMPLE.md) | §6 (`lines 183, 186, 356–365, 431–452, 1132–1169, 1206`) | `slack.bot(...)`, `github.webhookStream(...)`, `github.issues(...)` in `engineering-harness.ts`. |

---

## 3. Planned Module Decomposition & Public Exports

Every file in `packages/{github,slack,stripe,netsuite}/src/**` and `test/fixtures/**` adheres to [`docs/CODING_GUIDELINES.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_GUIDELINES.md) §1–§5 (`<= 250` lines per file, single primary concept per file, `internal/` helpers, pure `src/index.ts` barrels, complete `/** ... */` JSDoc, and zero inline/non-JSDoc comments).

### 3.1 `packages/github` (`@harness-dsl/github`)

| File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `src/builders/github-builders.ts` | `function` | `createGithubIssuesBuilder`, `createGithubWebhookStreamBuilder`, `createGithubCreateOrUpdatePrBuilder`, `GithubCreateOrUpdatePrBuilder` |
| `src/builders/github-namespace.constants.ts` | `const` | `github`, `GithubNamespace` |
| `src/executors/github-http-transport.ts` | `interface` | `GithubHttpTransport`, `GithubIssueRecord`, `defaultGithubHttpTransport` |
| `src/executors/github-issues-tracker.ts` | `class` | `GithubIssuesTrackerAdapter` (implementing `TrackerAdapter<GithubIssueRecord, string>`) |
| `src/executors/github-webhook-stream.ts` | `class` | `GithubWebhookStreamSource` (implementing `StreamSource<any>` with HMAC-SHA256 `X-Hub-Signature-256` verification) |
| `src/executors/github-pr-step-executor.ts` | `function` | `executeGithubCreateOrUpdatePrStep` |
| `src/executors/github-executors.constants.ts` | `const` | `githubExecutors: RuntimeExecutorRegistrySlice`, `createGithubExecutors` |
| `src/index.ts` | `barrel` | Pure explicit re-exports of `github`, `githubExecutors`, `createGithubExecutors`, `GithubIssuesTrackerAdapter`, `GithubWebhookStreamSource`, `GithubHttpTransport`, `GithubIssueRecord`, `GithubCreateOrUpdatePrBuilder`, `GithubIssuesTrackerNode`, `GithubWebhookStreamNode`, `GithubCreateOrUpdatePrNode` |

### 3.2 `packages/slack` (`@harness-dsl/slack`)

| File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `src/builders/slack-builders.ts` | `function` | `createSlackBotBuilder`, `createSlackWebhookBuilder` |
| `src/builders/slack-namespace.constants.ts` | `const` | `slack`, `SlackNamespace` |
| `src/executors/slack-transport.ts` | `interface` | `SlackTransport`, `defaultSlackTransport` |
| `src/executors/slack-approver-adapter.ts` | `class` | `SlackApproverAdapter` (implementing `HumanAdapter` and `ControlPlaneAdapter`) |
| `src/executors/slack-notifier-adapter.ts` | `class` | `SlackNotifierAdapter` (implementing `HumanAdapter` for `'notify-only'`) |
| `src/executors/slack-executors.constants.ts` | `const` | `slackExecutors: RuntimeExecutorRegistrySlice`, `createSlackExecutors` |
| `src/index.ts` | `barrel` | Pure explicit re-exports of `slack`, `slackExecutors`, `createSlackExecutors`, `SlackApproverAdapter`, `SlackNotifierAdapter`, `SlackTransport`, `SlackApproverNode`, `SlackNotifierNode` |

### 3.3 `packages/stripe` (`@harness-dsl/stripe`) & `packages/netsuite` (`@harness-dsl/netsuite`)

| Package & File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `packages/stripe/src/nodes/stripe-domain-nodes.ts` | `interface` | `StripeReadToolNode`, `StripeMaxRefundGuardNode`, `StripeMaxRefundMatcherNode` |
| `packages/stripe/src/builders/stripe-namespace.constants.ts` | `const` | `stripe`, `StripeNamespace` (`readTools`, `maxRefundGuardUsd`, `allowRefundUpToUsd`) |
| `packages/stripe/src/executors/stripe-executors.constants.ts` | `const` | `stripeExecutors: RuntimeExecutorRegistrySlice`, `createStripeExecutors` |
| `packages/stripe/src/index.ts` | `barrel` | Pure explicit re-exports of `stripe`, `stripeExecutors`, `createStripeExecutors`, `StripeReadToolNode`, `StripeMaxRefundGuardNode`, `StripeMaxRefundMatcherNode` |
| `packages/netsuite/src/nodes/netsuite-domain-nodes.ts` | `interface` | `NetSuiteDraftHandle`, `DraftJournalReceipt`, `NetSuiteDraftScopeNode`, `NetSuiteClosedPeriodGuardNode`, `NetSuiteJournalToolNode`, `NetSuiteBalanceZeroCheckNode`, `NetSuiteRollbackAbortHookNode` |
| `packages/netsuite/src/builders/netsuite-namespace.constants.ts` | `const` | `netsuite`, `NetSuiteNamespace` (`draftJournalScope`, `forbidClosedPeriodPosting`, `journalTools`, `balanceZeroCheck`, `rollbackDraftJournal`) |
| `packages/netsuite/src/executors/netsuite-draft-scope-driver.ts` | `class` | `NetSuiteDraftScopeDriver` (implementing Tier-1 `IsolationScope<NetSuiteDraftHandle, DraftJournalReceipt>`) |
| `packages/netsuite/src/executors/netsuite-executors.constants.ts` | `const` | `netsuiteExecutors: RuntimeExecutorRegistrySlice`, `createNetSuiteExecutors` |
| `packages/netsuite/src/index.ts` | `barrel` | Pure explicit re-exports of `netsuite`, `netsuiteExecutors`, `createNetSuiteExecutors`, `NetSuiteDraftScopeDriver`, `NetSuiteDraftHandle`, `DraftJournalReceipt`, `NetSuiteDraftScopeNode`, `NetSuiteClosedPeriodGuardNode`, `NetSuiteJournalToolNode`, `NetSuiteBalanceZeroCheckNode`, `NetSuiteRollbackAbortHookNode` |

---

## 4. Detailed Implementation Requirements

### 4.1 `@harness-dsl/github` (`SPEC.md` §4.5 line 3177 & `CODING_SAMPLE.md` lines 431–452, 1132–1169)
1. **`github.issues({ repo, token, labels? })`**:
   - Compiles to `GithubIssuesTrackerNode` (`readonly type: 'github:issues'`).
   - `GithubIssuesTrackerAdapter` (`trackers['github:issues']`) implements `poll()` (fetching issues from `/repos/${repo}/issues` with resolved `token`) and `setExternalState(itemKey, state)` (updating issue labels on `/repos/${repo}/issues/${issueNumber}/labels`).
2. **`github.webhookStream({ repo?, port?, path?, secret, events })`**:
   - Compiles to `GithubWebhookStreamNode` (`readonly type: 'github:webhook-stream'`, defaulting `port` to `3000` and `path` to `'/webhooks/github'`).
   - `GithubWebhookStreamSource` (`streamSources['github:webhook-stream']`) verifies HMAC-SHA256 (`X-Hub-Signature-256`) using resolved `secret`, filters by `X-GitHub-Event` / `payload.action` against `node.events` and `payload.repository.full_name` against `node.repo`, and invokes `onEvent(payload)`.
3. **`github.createOrUpdatePr(id, { repo, token, branch, baseBranch?, title, body })`**:
   - Compiles to `GithubCreateOrUpdatePrNode` (`readonly type: 'github:create-or-update-pr'`, supporting `.input(schema)` and `.output(schema)`).
   - Step executor queries open PRs for `head: branch(input)` and creates or updates the PR on `/repos/${repo}/pulls`.

### 4.2 `@harness-dsl/slack` (`SPEC.md` §4.5 line 3178 & `CODING_SAMPLE.md` lines 356–365, 1197–1206)
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

### 4.3 `@harness-dsl/stripe` & `@harness-dsl/netsuite` (`SPEC.md` §5 lines 3182–3324)
- Implement the exact Tier-1 (`capabilityTier: 'scope'`) scope, tools (`effectTracking: 'declared'`), policy guards (`forbidClosedPeriodPosting`, `maxRefundGuardUsd(500)`), lease delta (`allowRefundUpToUsd(10_000)`), check (`balanceZeroCheck`), and abort hook (`rollbackDraftJournal`) specified in `SPEC.md` §5 so the non-coding financial harness compiles and executes end-to-end without git semantics.

---

## 5. Deterministic Test Suite Architecture (`test/**` & `test/fixtures/**`)

| File Path | Line Ceiling | Required Deterministic Test Cases |
| :--- | :--- | :--- |
| `packages/github/test/github-adapter.test.ts` | `<= 400` | Verifies `github.issues`, `github.webhookStream` (default `port: 3000`, `path: '/webhooks/github'`, HMAC-SHA256 verification, event & repo filtering), and `github.createOrUpdatePr` using a deterministic recorded transport / local HTTP webhook test client. |
| `packages/slack/test/slack-adapter.test.ts` | `<= 400` | Verifies `slack.bot` (`interactionMode: 'bidirectional'`, `notify`, `requestDecision` with schema validation and keep-alive heartbeats, `cancelDecision` superseding active requests, `start(controller)` control-plane signal emission) and `slack.webhook` (`interactionMode: 'notify-only'`). |
| `packages/stripe/test/stripe-adapter.test.ts` | `<= 400` | Verifies `stripe.readTools()`, `stripe.maxRefundGuardUsd(500)` pre-flight `ToolEffect` evaluation, and `stripe.allowRefundUpToUsd(10_000)` `LeaseDelta` matcher elevation. |
| `packages/netsuite/test/netsuite-adapter.test.ts` | `<= 400` | Verifies `netsuite.draftJournalScope()` Tier-1 `IsolationScope` (`capabilityTier: 'scope'`, `acquireRoot`, `reattachRoot`, `inspect`, `release`), `netsuite.forbidClosedPeriodPosting()`, `netsuite.journalTools()`, `netsuite.balanceZeroCheck()`, and `netsuite.rollbackDraftJournal()`. |

---

## 6. Verification Gate Commands

Run from workspace root:

```bash
pnpm --filter @harness-dsl/github --filter @harness-dsl/slack --filter @harness-dsl/stripe --filter @harness-dsl/netsuite typecheck
pnpm --filter @harness-dsl/github --filter @harness-dsl/slack --filter @harness-dsl/stripe --filter @harness-dsl/netsuite test -- --reporter=verbose
test -z "$(git status --porcelain -- packages/core packages/sqlite packages/postgres packages/fs packages/markdown packages/node packages/git packages/claude packages/openai packages/gemini packages/integration)"
```
