# Milestone 3f (`M3f`): `@harness-dsl/github` & `@harness-dsl/slack` External Connectors

## 1. Scope & Package Directory

- **Milestone Wave:** Parallel Wave 2 — Scoped Adapter Builder (`c`) (Depends on Wave 1a `M1` -> Wave 1b `M2` completing)
- **Owned Files & Directories:**
  - `packages/github/src/issues-tracker.ts`
  - `packages/github/src/webhook-stream.ts`
  - `packages/github/src/index.ts`
  - `packages/github/test/github-adapter.test.ts`
  - `packages/slack/src/webhook.ts`
  - `packages/slack/src/bot.ts`
  - `packages/slack/src/index.ts`
  - `packages/slack/test/slack-adapter.test.ts`
- **Forbidden Directories:**
  - Do not modify root workspace files (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `pnpm-lock.yaml`) or `packages/core/**`.
  - Do not touch `packages/sqlite`, `packages/postgres`, `packages/fs`, `packages/markdown`, `packages/node`, `packages/git`, `packages/claude`, `packages/openai`, `packages/stripe`, `packages/netsuite`, or `packages/integration`.
  - Zero cross-milestone adapter imports: `packages/github` and `packages/slack` import only from `@harness-dsl/core`, `zod`, and Node.js built-ins (`node:crypto`, `node:http`).

---

## 2. Exact Spec Grounding Table

Read the following sections in full before authoring any file in `M3f`:

| Document | Section | Line Range | Key Contracts & Connector Semantics Covered |
| :--- | :--- | :--- | :--- |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §1.1 Package Boundaries & §1.2 Invariant 3 | `22–23, 29` | `@harness-dsl/github` and `@harness-dsl/slack` responsibilities; opaque `EnvRef` resolution |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.7 External Tracker, Stream, Human & Control-Plane Ports | `831–868` | `TrackerAdapter`, `StreamSource`, `HumanAdapter`, `ControlPlaneAdapter`, `HarnessRuntimeController` |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §3.1 Signals & Streams, §3.6 Humans (`H.human`), §3.7.2 & §3.10 `cancelDecision` | `875–880, 1033–1036, 1200, 1318` | Bidirectional `HumanAdapter` requirement (`requestDecision` + `cancelDecision`), sibling-interrupt & rewind cancellation |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §4.5 `@harness-dsl/github` & `@harness-dsl/slack` | `1429–1435` | `github.issues`, `github.webhookStream`, `slack.webhook`, `slack.bot` |
| [`docs/CODING_SAMPLE.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_SAMPLE.md) | §6 `engineering-harness.ts` | `356–365, 431–452, 1132–1170, 1204–1207` | `slackBot`, `owner`, `githubWebhookSource`, `githubMergeStream`, `githubPrClosedStream`, `issuesTracker` |

---

## 3. File-by-File Architecture & Exported Symbols

### 3.1 `packages/github/src/index.ts`

```ts
import type { EnvRef, StreamSource, TrackerAdapter } from '@harness-dsl/core';

export interface GitHubIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: 'open' | 'closed';
  readonly labels: readonly string[];
  readonly html_url?: string;
}

export interface GitHubPullRequestWebhookEvent {
  readonly action: string;
  readonly repository?: { readonly full_name: string };
  readonly pull_request: {
    readonly number: number;
    readonly merged: boolean;
    readonly merge_commit_sha: string;
    readonly head: { readonly ref: string; readonly sha?: string };
    readonly base: { readonly ref: string };
  };
}

export type GitHubFetchTransport = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
  },
) => Promise<{
  readonly status: number;
  readonly json(): Promise<unknown>;
  readonly text(): Promise<string>;
}>;

export interface GitHubWebhookStreamSource extends StreamSource<GitHubPullRequestWebhookEvent> {
  ingestWebhook(req: {
    readonly headers: Readonly<Record<string, string | undefined>>;
    readonly rawBody: string | Uint8Array;
  }): Promise<boolean>;
}

export const github: {
  issues(opts: {
    readonly repo: string;
    readonly token: EnvRef | string;
    readonly apiBaseUrl?: string;
    readonly transport?: GitHubFetchTransport;
  }): TrackerAdapter<GitHubIssue, string>;
  webhookStream(opts: {
    readonly repo: string;
    readonly secret: EnvRef | string;
    readonly events: readonly string[];
    readonly port?: number;
  }): GitHubWebhookStreamSource;
};
```

### 3.2 `packages/slack/src/index.ts`

```ts
import type { ControlPlaneAdapter, EnvRef, HumanAdapter } from '@harness-dsl/core';

export interface SlackMessageRecord {
  readonly ts: string;
  readonly channel: string;
  readonly text: string;
  readonly threadTs?: string;
  readonly requestId?: string;
  readonly runId?: string;
  readonly cancelled?: boolean;
}

export interface SlackBotTransport {
  postMessage(msg: {
    readonly channel: string;
    readonly text: string;
    readonly threadTs?: string;
    readonly requestId?: string;
    readonly runId?: string;
  }): Promise<{ readonly ts: string }>;
  updateMessage(msg: {
    readonly channel: string;
    readonly ts: string;
    readonly text: string;
    readonly cancelled?: boolean;
  }): Promise<void>;
}

export interface SlackBotAdapter extends HumanAdapter, ControlPlaneAdapter {
  submitDecisionResponse(requestId: string, rawPayload: unknown): Promise<void>;
  triggerControlSignal<TPayload>(signalId: string, payload: TPayload): Promise<void>;
  getPostedMessages(): readonly SlackMessageRecord[];
}

export const slack: {
  webhook(
    url: EnvRef | string,
    opts?: {
      readonly transport?: (url: string, body: string) => Promise<{ readonly status: number }>;
    },
  ): HumanAdapter;
  bot(opts: {
    readonly appToken: EnvRef | string;
    readonly botToken: EnvRef | string;
    readonly channel: EnvRef | string;
    readonly transport?: SlackBotTransport;
  }): SlackBotAdapter;
};
```

---

## 4. Critical Implementation Invariants

1. **`github.issues` Polling & Label State Transitions (`SPEC.md` §2.7, §4.5; `CODING_SAMPLE.md` lines 1132–1170):**
   - Resolves `token` (`EnvRef` or string) in-memory at invocation time.
   - `poll()` fetches open issues from `/repos/${repo}/issues?state=open&per_page=100`, excludes GitHub pull requests (`item.pull_request !== undefined`), maps label objects (`{ name: string }` or `string`) to `readonly string[]`, and returns `GitHubIssue[]`.
   - `setExternalState(itemKey, state)` extracts issue number from `itemKey` (e.g., `'#102'` -> `102`), fetches current issue labels, preserves non-lifecycle labels (`partition:db`, `partition:api`, `partition:web`, `epic`, `architecture`, `deep`), replaces any prior lifecycle state label (`agent-ready`, `queued`, `in-progress`, `needs-human`, `errored`, `cancelled`, `pr-open`, `needs-triage`) with `state`, and writes the updated label set via `PUT /repos/${repo}/issues/${issueNumber}/labels`.
2. **`github.webhookStream` HMAC-SHA256 Verification & Event Filtering (`SPEC.md` §2.7, §3.1; `CODING_SAMPLE.md` lines 431–452):**
   - Resolves `secret` (`EnvRef` or string) in-memory at verification time.
   - Computes `expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')` and compares against `headers['x-hub-signature-256']` using `crypto.timingSafeEqual` (returning `false` and dropping the payload on mismatch or missing signature).
   - Verifies `${eventHeader}.${payload.action}` (or `${eventHeader}`) is in `opts.events` (e.g., `'pull_request.closed'`) and, if `payload.repository?.full_name` is present, matches `opts.repo`.
   - Delivers matching events to all active callbacks registered via `subscribe(onEvent)`.
3. **`slack.webhook` vs `slack.bot` Bidirectional Enforcement (`SPEC.md` §3.6 lines 1033–1036):**
   - `slack.webhook(url)` implements `notify(message)` via HTTP `POST` JSON `{ text: message }` and throws an explicit error if `requestDecision` is called on it.
   - `slack.bot(opts)` implements both `HumanAdapter` (`notify`, `requestDecision`, `cancelDecision`) and `ControlPlaneAdapter` (`start`).
   - In `requestDecision(req)`:
     - Posts a message for `req.requestId` (or if `req.payload` carries `replacesRequestId` referencing an earlier message `ts`, updates the prior Slack message via `updateMessage` and posts a thread reply referencing that `ts`).
     - Validates human responses submitted via Socket Mode / `submitDecisionResponse(requestId, rawPayload)` against `req.responseSchema` using `safeParse`; if invalid, posts an in-thread validation error and keeps waiting for a valid response.
     - If `req.signal` aborts or `cancelDecision(runId, requestId)` is called, updates the Slack message (`cancelled: true`), cleans up any keep-alive interval timer, and rejects the pending `requestDecision` promise with an `AbortError`.

---

## 5. Required Test Suite (`packages/github/test/*.test.ts` & `packages/slack/test/*.test.ts`)

1. **`github-adapter.test.ts`:**
   - `github.issues`: `poll()` filtering out PRs and normalizing labels; `setExternalState('#42', 'in-progress')` stripping `agent-ready`/`queued` while preserving `partition:db` and `epic`; `CODING_SAMPLE.md` `.from(issue)` mapper integration test.
   - `github.webhookStream`: valid HMAC-SHA256 signature acceptance vs invalid/tampered signature rejection (`timingSafeEqual`); filtering `pull_request.closed` merged (`githubMergeStream` -> `changeShippedSignal`) vs unmerged (`githubPrClosedStream` -> `prClosedUnmergedSignal`).
2. **`slack-adapter.test.ts`:**
   - `slack.webhook`: `notify()` delivery and `requestDecision()` throwing bidirectional requirement error.
   - `slack.bot`: `notify()`, `requestDecision()` with Zod schema validation (rejecting malformed response and resolving on valid response), `replacesRequestId` updating the original message and replying in-thread, `cancelDecision(runId, requestId)` and `AbortSignal` cancellation updating the Slack message and rejecting the pending promise, and `ControlPlaneAdapter.start(runtime)` forwarding signals via `triggerControlSignal`.

---

## 6. Verification Gate Commands

```bash
pnpm check:comments
pnpm --filter @harness-dsl/github typecheck
pnpm --filter @harness-dsl/github test
pnpm --filter @harness-dsl/slack typecheck
pnpm --filter @harness-dsl/slack test
```
