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
  - Root workspace configs (`package.json`, `eslint.config.mjs`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`) and `docs/**`
- **Cross-Adapter Independence Rule**:
  - `@harness-dsl/github`, `@harness-dsl/slack`, `@harness-dsl/stripe`, and `@harness-dsl/netsuite` must have **zero runtime or type imports** from each other or from any other M3 adapter package. Each depends exclusively on `@harness-dsl/core` (`workspace:*`), `zod`, and Node built-ins (`node:http`, `node:crypto`).

---

## 2. Normative Specification & Coding Sample Grounding

| Normative Source | Section & Exact Line Range | Grounded Scope in `M3f` |
| :--- | :--- | :--- |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §1.1–§1.2 (`lines 3–34`) | Pure passive AST nodes (`GithubIssuesTrackerNode`, `GithubWebhookStreamNode`, `GithubCreateOrUpdatePrNode`, `SlackApproverNode`, `SlackNotifierNode`, `StripeReadToolNode`, `StripeMaxRefundGuardNode`, `StripeMaxRefundMatcherNode`, `NetSuiteDraftScopeNode`, `NetSuiteClosedPeriodGuardNode`, `NetSuiteJournalToolNode`, `NetSuiteBalanceZeroCheckNode`, `NetSuiteRollbackAbortHookNode`), namespaced `CustomDomainASTRegistry` declaration merging (`'tool:stripe'`, `'guard:stripe'`, `'effectMatcher:stripe'`, `'scope:netsuite'`, `'guard:netsuite'`, `'abortHook:netsuite'`, `'tool:netsuite'`, `'check:netsuite'`), and late-bound `EnvRef` resolution via `ctx.resolveEnv`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.2–§2.5 & §2.8 (`lines 682–1505`, `2089–2123`) | `BaseTrackerASTNode`, `BaseStreamSourceASTNode`, `BaseDomainStepASTNode`, `BaseHumanChannelASTNode` (`interactionMode: 'bidirectional' \| 'notify-only'`), `BaseControlPlaneASTNode`, `BaseIsolationScopeASTNode` (`capabilityTier: 'scope'`), `BaseToolASTNode` (`effectTracking: 'declared'`), `BasePolicyGuardASTNode`, `BaseCheckASTNode`, `BaseAbortHookASTNode`, `IsolationScope`, `TrackerAdapter`, `StreamSource`, `HumanAdapter`, `ControlPlaneAdapter`, `RuntimeExecutorRegistrySlice`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §4.5 (`lines 3136–3179`) | `@harness-dsl/github` (`github.issues(opts)`, `github.webhookStream(opts)` defaulting `port` to `3000` and `path` to `'/webhooks/github'`, `github.createOrUpdatePr(id, opts)`) and `@harness-dsl/slack` (`slack.webhook(url)` with `interactionMode: 'notify-only'`, `slack.bot(opts)` with `interactionMode: 'bidirectional'` implementing `HumanAdapter` & `ControlPlaneAdapter`). |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §5 (`lines 3182–3324`) | Non-coding financial harness domain adapters `@harness-dsl/stripe` (`stripe.readTools()`, `stripe.maxRefundGuardUsd(limit)`, `stripe.allowRefundUpToUsd(limit)`) and `@harness-dsl/netsuite` (`netsuite.draftJournalScope()` with `capabilityTier: 'scope'`, `netsuite.forbidClosedPeriodPosting()`, `netsuite.journalTools()`, `netsuite.balanceZeroCheck()`, `netsuite.rollbackDraftJournal()`). |
| [`docs/CODING_SAMPLE.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_SAMPLE.md) | §6 (`lines 183, 186, 356–365, 431–452, 1132–1169, 1206`) | `slack.bot(...)`, `github.webhookStream(...)`, `github.issues(...)` in `engineering-harness.ts`. |

---

## 3. Planned Module Decomposition & Public Exports

Every file in `packages/{github,slack,stripe,netsuite}/src/**` and `test/fixtures/**` adheres to [`docs/CODING_GUIDELINES.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_GUIDELINES.md) §1–§5 (`<= 250` lines per file, zero co-location of `interface` / `function` / `class` / `const` / `type`, strictly 1 top-level `interface` per file plus `TSPropertySignature` property sub-interfaces only, 1 `class` per file, 1 builder factory function per `create-*.ts` file, `internal/` helpers, pure `src/index.ts` barrels, full 3-part `/** ... */` JSDoc on every declaration and `TSMethodSignature`, and zero inline/non-JSDoc comments).

### 3.1 `packages/github` (`@harness-dsl/github`)

| File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `src/builders/github-issues-options.ts` | `interface` | `GithubIssuesOptions` |
| `src/builders/github-webhook-stream-options.ts` | `interface` | `GithubWebhookStreamOptions` |
| `src/builders/github-create-or-update-pr-options.ts` | `interface` | `GithubCreateOrUpdatePrOptions<TIn>` |
| `src/builders/github-create-or-update-pr-builder.ts` | `interface` | `GithubCreateOrUpdatePrBuilder<TIn, TOut, THandle>` |
| `src/builders/create-github-issues-builder.ts` | `function` | `createGithubIssuesBuilder` |
| `src/builders/create-github-webhook-stream-builder.ts` | `function` | `createGithubWebhookStreamBuilder` |
| `src/builders/create-github-create-or-update-pr-builder.ts` | `function` | `createGithubCreateOrUpdatePrBuilder` |
| `src/builders/github-namespace-contract.ts` | `interface` | `GithubNamespace` |
| `src/builders/github-namespace.ts` | `const` | `github: GithubNamespace` |
| `src/executors/github-issue-record.ts` | `interface` | `GithubIssueRecord` |
| `src/executors/github-http-transport.ts` | `interface` | `GithubHttpTransport` |
| `src/executors/default-github-http-transport.constants.ts` | `const` | `defaultGithubHttpTransport: GithubHttpTransport` |
| `src/executors/github-issues-tracker.ts` | `class` | `GithubIssuesTrackerAdapter` (implementing `TrackerAdapter<GithubIssueRecord, string>`) |
| `src/executors/github-webhook-stream.ts` | `class` | `GithubWebhookStreamSource` (implementing `StreamSource<unknown>` with HMAC-SHA256 `X-Hub-Signature-256` verification) |
| `src/executors/github-pr-step-executor.ts` | `function` | `executeGithubCreateOrUpdatePrStep` |
| `src/executors/create-github-executors.ts` | `function` | `createGithubExecutors` |
| `src/executors/github-executors.constants.ts` | `const` | `githubExecutors: RuntimeExecutorRegistrySlice` |
| `src/index.ts` | `barrel` | Pure explicit re-exports of `github`, `GithubNamespace`, `githubExecutors`, `createGithubExecutors`, `GithubIssuesTrackerAdapter`, `GithubWebhookStreamSource`, `GithubHttpTransport`, `defaultGithubHttpTransport`, `GithubIssueRecord`, `GithubCreateOrUpdatePrBuilder`, `GithubIssuesOptions`, `GithubWebhookStreamOptions`, `GithubCreateOrUpdatePrOptions`, `createGithubIssuesBuilder`, `createGithubWebhookStreamBuilder`, `createGithubCreateOrUpdatePrBuilder`, `GithubIssuesTrackerNode`, `GithubWebhookStreamNode`, `GithubCreateOrUpdatePrNode` |

### 3.2 `packages/slack` (`@harness-dsl/slack`)

| File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `src/builders/slack-bot-options.ts` | `interface` | `SlackBotOptions` |
| `src/builders/create-slack-bot-builder.ts` | `function` | `createSlackBotBuilder` |
| `src/builders/create-slack-webhook-builder.ts` | `function` | `createSlackWebhookBuilder` |
| `src/builders/slack-namespace-contract.ts` | `interface` | `SlackNamespace` |
| `src/builders/slack-namespace.ts` | `const` | `slack: SlackNamespace` |
| `src/executors/slack-transport.ts` | `interface` | `SlackTransport` |
| `src/executors/default-slack-transport.constants.ts` | `const` | `defaultSlackTransport: SlackTransport` |
| `src/executors/slack-approver-adapter.ts` | `class` | `SlackApproverAdapter` (implementing `HumanAdapter` and `ControlPlaneAdapter`) |
| `src/executors/slack-notifier-adapter.ts` | `class` | `SlackNotifierAdapter` (implementing `HumanAdapter` for `'notify-only'`) |
| `src/executors/create-slack-executors.ts` | `function` | `createSlackExecutors` |
| `src/executors/slack-executors.constants.ts` | `const` | `slackExecutors: RuntimeExecutorRegistrySlice` |
| `src/index.ts` | `barrel` | Pure explicit re-exports of `slack`, `SlackNamespace`, `slackExecutors`, `createSlackExecutors`, `SlackApproverAdapter`, `SlackNotifierAdapter`, `SlackTransport`, `defaultSlackTransport`, `SlackBotOptions`, `createSlackBotBuilder`, `createSlackWebhookBuilder`, `SlackApproverNode`, `SlackNotifierNode` |

### 3.3 `packages/stripe` (`@harness-dsl/stripe`) & `packages/netsuite` (`@harness-dsl/netsuite`)

| Package & File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `packages/stripe/src/nodes/stripe-read-tool-node.ts` | `interface` | `StripeReadToolNode` |
| `packages/stripe/src/nodes/stripe-max-refund-guard-node.ts` | `interface` | `StripeMaxRefundGuardNode` |
| `packages/stripe/src/nodes/stripe-max-refund-matcher-node.ts` | `interface` | `StripeMaxRefundMatcherNode` |
| `packages/stripe/src/nodes/stripe-registry-augmentation.ts` | `interface` | `declare module '@harness-dsl/core'` augmenting `CustomDomainASTRegistry` with `'tool:stripe'`, `'guard:stripe'`, `'effectMatcher:stripe'` |
| `packages/stripe/src/builders/create-stripe-read-tools.ts` | `function` | `createStripeReadTools` |
| `packages/stripe/src/builders/create-stripe-max-refund-guard-builder.ts` | `function` | `createStripeMaxRefundGuardBuilder` |
| `packages/stripe/src/builders/create-stripe-allow-refund-lease-delta.ts` | `function` | `createStripeAllowRefundLeaseDelta` |
| `packages/stripe/src/builders/stripe-namespace-contract.ts` | `interface` | `StripeNamespace` (`readTools`, `maxRefundGuardUsd`, `allowRefundUpToUsd`) |
| `packages/stripe/src/builders/stripe-namespace.ts` | `const` | `stripe: StripeNamespace` |
| `packages/stripe/src/executors/create-stripe-executors.ts` | `function` | `createStripeExecutors` |
| `packages/stripe/src/executors/stripe-executors.constants.ts` | `const` | `stripeExecutors: RuntimeExecutorRegistrySlice` |
| `packages/stripe/src/index.ts` | `barrel` | Pure explicit re-exports of `stripe`, `StripeNamespace`, `stripeExecutors`, `createStripeExecutors`, `createStripeReadTools`, `createStripeMaxRefundGuardBuilder`, `createStripeAllowRefundLeaseDelta`, `StripeReadToolNode`, `StripeMaxRefundGuardNode`, `StripeMaxRefundMatcherNode` |
| `packages/netsuite/src/nodes/netsuite-draft-handle.ts` | `interface` | `NetSuiteDraftHandle` |
| `packages/netsuite/src/nodes/draft-journal-receipt.ts` | `interface` | `DraftJournalReceipt` |
| `packages/netsuite/src/nodes/netsuite-draft-scope-node.ts` | `interface` | `NetSuiteDraftScopeNode` |
| `packages/netsuite/src/nodes/netsuite-closed-period-guard-node.ts` | `interface` | `NetSuiteClosedPeriodGuardNode` |
| `packages/netsuite/src/nodes/netsuite-journal-tool-node.ts` | `interface` | `NetSuiteJournalToolNode` |
| `packages/netsuite/src/nodes/netsuite-balance-zero-check-node.ts` | `interface` | `NetSuiteBalanceZeroCheckNode` |
| `packages/netsuite/src/nodes/netsuite-rollback-abort-hook-node.ts` | `interface` | `NetSuiteRollbackAbortHookNode` |
| `packages/netsuite/src/nodes/netsuite-registry-augmentation.ts` | `interface` | `declare module '@harness-dsl/core'` augmenting `CustomDomainASTRegistry` with `'scope:netsuite'`, `'guard:netsuite'`, `'abortHook:netsuite'`, `'tool:netsuite'`, `'check:netsuite'` |
| `packages/netsuite/src/builders/create-netsuite-draft-journal-scope-builder.ts` | `function` | `createNetSuiteDraftJournalScopeBuilder` |
| `packages/netsuite/src/builders/create-netsuite-closed-period-guard-builder.ts` | `function` | `createNetSuiteClosedPeriodGuardBuilder` |
| `packages/netsuite/src/builders/create-netsuite-journal-tools.ts` | `function` | `createNetSuiteJournalTools` |
| `packages/netsuite/src/builders/create-netsuite-balance-zero-check-builder.ts` | `function` | `createNetSuiteBalanceZeroCheckBuilder` |
| `packages/netsuite/src/builders/create-netsuite-rollback-abort-hook-builder.ts` | `function` | `createNetSuiteRollbackAbortHookBuilder` |
| `packages/netsuite/src/builders/netsuite-namespace-contract.ts` | `interface` | `NetSuiteNamespace` (`draftJournalScope`, `forbidClosedPeriodPosting`, `journalTools`, `balanceZeroCheck`, `rollbackDraftJournal`) |
| `packages/netsuite/src/builders/netsuite-namespace.ts` | `const` | `netsuite: NetSuiteNamespace` |
| `packages/netsuite/src/executors/netsuite-draft-scope-driver.ts` | `class` | `NetSuiteDraftScopeDriver` (implementing Tier-1 `IsolationScope<NetSuiteDraftHandle, DraftJournalReceipt>`) |
| `packages/netsuite/src/executors/create-netsuite-executors.ts` | `function` | `createNetSuiteExecutors` |
| `packages/netsuite/src/executors/netsuite-executors.constants.ts` | `const` | `netsuiteExecutors: RuntimeExecutorRegistrySlice` |
| `packages/netsuite/src/index.ts` | `barrel` | Pure explicit re-exports of `netsuite`, `NetSuiteNamespace`, `netsuiteExecutors`, `createNetSuiteExecutors`, `NetSuiteDraftScopeDriver`, `createNetSuiteDraftJournalScopeBuilder`, `createNetSuiteClosedPeriodGuardBuilder`, `createNetSuiteJournalTools`, `createNetSuiteBalanceZeroCheckBuilder`, `createNetSuiteRollbackAbortHookBuilder`, `NetSuiteDraftHandle`, `DraftJournalReceipt`, `NetSuiteDraftScopeNode`, `NetSuiteClosedPeriodGuardNode`, `NetSuiteJournalToolNode`, `NetSuiteBalanceZeroCheckNode`, `NetSuiteRollbackAbortHookNode` |

---

## 4. Detailed Implementation Requirements

### 4.0 Strict File Separation & Full 3-Part JSDoc (`docs/CODING_GUIDELINES.md` §§1–2)
1. **Zero Co-Location of Entity Kinds**:
   - `interface`, `function`, `class`, `const`, and `type` declarations must **never** live in the same file in `packages/{github,slack,stripe,netsuite}/src/**` or `packages/{github,slack,stripe,netsuite}/test/fixtures/**`.
   - Every domain AST node interface (`StripeReadToolNode`, `StripeMaxRefundGuardNode`, `StripeMaxRefundMatcherNode`, `NetSuiteDraftHandle`, `DraftJournalReceipt`, `NetSuiteDraftScopeNode`, `NetSuiteClosedPeriodGuardNode`, `NetSuiteJournalToolNode`, `NetSuiteBalanceZeroCheckNode`, `NetSuiteRollbackAbortHookNode`), every builder/options/transport interface, and every namespace contract (`*-namespace-contract.ts`) gets its own single-interface file; every builder factory function (`create-*.ts`) gets its own single-function file; every adapter class (`GithubIssuesTrackerAdapter`, `GithubWebhookStreamSource`, `SlackApproverAdapter`, `SlackNotifierAdapter`, `NetSuiteDraftScopeDriver`) gets its own single-class file; every `const` (`github`, `slack`, `stripe`, `netsuite`, `default*Transport`, `*Executors`) lives in its own `const`-only file.
2. **Full 3-Part JSDoc Requirement**:
   - Every `interface`, `class`, `function`, class method, **interface method signature (`TSMethodSignature`)**, `type`, and exported `const` in `src/**` and `test/fixtures/**` must carry full 3-part JSDoc per `docs/CODING_GUIDELINES.md` §2 (2-paragraph Summary + Detailed description separated by a blank `*` line, vertically aligned `@template` and `@param {Type} name - Description`, and `@returns {Type} Description`), enforced by `pnpm --filter @harness-dsl/github --filter @harness-dsl/slack --filter @harness-dsl/stripe --filter @harness-dsl/netsuite lint`.

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
- Implement the exact Tier-1 (`capabilityTier: 'scope'`) scope, tools (`effectTracking: 'declared'`), policy guards (`forbidClosedPeriodPosting`, `maxRefundGuardUsd(500)`), lease delta (`allowRefundUpToUsd(10_000)` with `grantedMatchers: [{ type: 'stripe:max-refund-matcher', id, maxRefundUsd }]`), check (`balanceZeroCheck`), and abort hook (`rollbackDraftJournal`) specified in `SPEC.md` §5 so the non-coding financial harness compiles and executes end-to-end without git semantics.
- **Collision-Free `CustomDomainASTRegistry` Augmentation**:
  - `packages/stripe` augments `CustomDomainASTRegistry` with namespaced keys `'tool:stripe': StripeReadToolNode; 'guard:stripe': StripeMaxRefundGuardNode; 'effectMatcher:stripe': StripeMaxRefundMatcherNode;`.
  - `packages/netsuite` augments `CustomDomainASTRegistry` with namespaced keys `'scope:netsuite': NetSuiteDraftScopeNode; 'guard:netsuite': NetSuiteClosedPeriodGuardNode; 'abortHook:netsuite': NetSuiteRollbackAbortHookNode; 'tool:netsuite': NetSuiteJournalToolNode; 'check:netsuite': NetSuiteBalanceZeroCheckNode;` so both packages compile independently and together without `TS2717` property type collisions.

---

## 5. Deterministic Test Suite Architecture (`test/**` & `test/fixtures/**`)

| File Path | Line Ceiling | Required Deterministic Test Cases |
| :--- | :--- | :--- |
| `packages/github/test/github-adapter.test.ts` | `<= 400` | Verifies `github.issues`, `github.webhookStream` (default `port: 3000`, `path: '/webhooks/github'`, HMAC-SHA256 verification, event & repo filtering), and `github.createOrUpdatePr` using a deterministic recorded transport / local HTTP webhook test client. |
| `packages/slack/test/slack-adapter.test.ts` | `<= 400` | Verifies `slack.bot` (`interactionMode: 'bidirectional'`, `notify`, `requestDecision` with schema validation and keep-alive heartbeats, `cancelDecision` superseding active requests, `start(controller)` control-plane signal emission) and `slack.webhook` (`interactionMode: 'notify-only'`). |
| `packages/stripe/test/stripe-adapter.test.ts` | `<= 400` | Verifies `stripe.readTools()`, `stripe.maxRefundGuardUsd(500)` pre-flight `ToolEffect` evaluation, `stripe.allowRefundUpToUsd(10_000)` `LeaseDelta` matcher elevation (`grantedMatchers`), and `'tool:stripe'` / `'guard:stripe'` / `'effectMatcher:stripe'` `CustomDomainAST` resolution. |
| `packages/netsuite/test/netsuite-adapter.test.ts` | `<= 400` | Verifies `netsuite.draftJournalScope()` Tier-1 `IsolationScope` (`capabilityTier: 'scope'`, `acquireRoot`, `reattachRoot`, `inspect`, `release`), `netsuite.forbidClosedPeriodPosting()`, `netsuite.journalTools()`, `netsuite.balanceZeroCheck()`, `netsuite.rollbackDraftJournal()`, and `'scope:netsuite'` / `'guard:netsuite'` / `'abortHook:netsuite'` / `'tool:netsuite'` / `'check:netsuite'` `CustomDomainAST` resolution. |

---

## 6. Verification Gate Commands

Run from workspace root (plus the `IMPL_LOOP.md` `baseline_dirty` diff check against `<non_sibling_forbidden_dirs_excluding_upstream_patches>`):

```bash
pnpm --filter @harness-dsl/github --filter @harness-dsl/slack --filter @harness-dsl/stripe --filter @harness-dsl/netsuite lint
pnpm --filter @harness-dsl/github --filter @harness-dsl/slack --filter @harness-dsl/stripe --filter @harness-dsl/netsuite typecheck
pnpm --filter @harness-dsl/github --filter @harness-dsl/slack --filter @harness-dsl/stripe --filter @harness-dsl/netsuite test -- --reporter=verbose
test -z "$(git status --porcelain -- docs .agents .claude package.json tsconfig.base.json vitest.config.ts)"
```
