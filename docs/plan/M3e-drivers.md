# Milestone 3e (`M3e`): `@harness-dsl/claude`, `@harness-dsl/openai` & `@harness-dsl/gemini` Model Drivers

## 1. Scope & Package Directory

- **Milestone Wave:** Parallel Wave 2 — Scoped Adapter Builder (`c`) (Depends on Wave 1a `M1` -> Wave 1b `M2` completing)
- **Owned Files & Directories:**
  - `packages/claude/src/accounts.ts`
  - `packages/claude/src/wire-format.ts`
  - `packages/claude/src/driver.ts`
  - `packages/claude/src/index.ts`
  - `packages/claude/test/claude-driver.test.ts`
  - `packages/claude/test/claude-fork-notes.test.ts`
  - `packages/openai/src/accounts.ts`
  - `packages/openai/src/wire-format.ts`
  - `packages/openai/src/driver.ts`
  - `packages/openai/src/index.ts`
  - `packages/openai/test/openai-driver.test.ts`
  - `packages/openai/test/openai-fork-failover.test.ts`
  - `packages/gemini/src/driver.ts`
  - `packages/gemini/src/index.ts`
  - `packages/gemini/test/gemini-driver.test.ts`
- **Forbidden Directories:**
  - Do not modify root workspace files (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `pnpm-lock.yaml`) or `packages/core/**`.
  - Do not touch `packages/sqlite`, `packages/postgres`, `packages/fs`, `packages/markdown`, `packages/node`, `packages/git`, `packages/github`, `packages/slack`, `packages/stripe`, `packages/netsuite`, or `packages/integration`.
  - Zero cross-milestone adapter imports: `packages/claude`, `packages/openai`, and `packages/gemini` import only from `@harness-dsl/core`, `zod`, and Node.js built-ins (`node:crypto`, `node:fs`, `node:os`, `node:path`).

---

## 2. Exact Spec Grounding Table

Read the following sections in full before authoring any file in `M3e`:

| Document | Section | Line Range | Key Contracts & Wire-Protocol Semantics Covered |
| :--- | :--- | :--- | :--- |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §1.1 Package Boundaries | `14–16` | `@harness-dsl/claude`, `@harness-dsl/openai`, and `@harness-dsl/gemini` responsibilities |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.5 `ModelDriver`, `CompiledWirePrefix`, `WireFrameRecord`, `ForkContext` | `308–430` | Exact `ModelDriver` method signatures (`invokeTurn`, `prepareFork`, `appendToolResultNotes`) and wire frame invariants |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §3.2 Capacity Pools (`H.pool`) & `H.prefixGroup` | `884–951` | Run-sticky account seat affinity, `429` failover, `'role-scoped'` vs `'union'` wire tool schemas |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §3.4.2 Skill Tombstones, §3.5 Epistemic Flush, §3.8 Cross-Model Loop Escalation | `1001–1006, 1066–1070, 1293` | Per-`callId` `compactedTombstones` substitution only on `substituteTombstones: true`, `toolChoice: 'none'` flush turns, omitted `childRoleContextFrameText` on same-actor escalation |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §4.1 `@harness-dsl/claude`, `@harness-dsl/openai` & `@harness-dsl/gemini` | `1369–1384` | Native `output_config.format` / `text.format` / `generationConfig.responseJsonSchema`, Anthropic `thinking` signature & Gemini `thoughtSignature` preservation vs cross-model stripping, empty text block omission, OpenAI `previous_response_id` & `rs_...`/`fc_...`/`msg_...`/`encrypted_content` stripping on cross-seat or cross-model transitions, full-turn `(1..k)` `tool_result` / `function_call_output` / `functionResponse` pairing |
| [`docs/CODING_SAMPLE.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_SAMPLE.md) | §6 `engineering-harness.ts` | `324–343` | `claude.cliAccount`, `claude.model`, `claudeAccounts`, `workerModels` |

---

## 3. File-by-File Architecture & Exported Symbols

### 3.1 `packages/claude/src/index.ts`

```ts
import type {
  AccountSeatDescriptor,
  EnvRef,
  ModelDescriptor,
  ModelDriver,
} from '@harness-dsl/core';

export type { AccountSeatDescriptor, ModelDescriptor };

export interface ClaudeAccountSeat extends AccountSeatDescriptor {
  readonly kind: 'claude:account-seat';
  readonly id: string;
  readonly configDirPath?: string;
  readonly apiKeyRef?: EnvRef | string;
  configDir(dirPath: string): ClaudeAccountSeat;
  apiKey(keyOrRef: EnvRef | string): ClaudeAccountSeat;
}

export interface ClaudeModelDef extends ModelDescriptor {
  readonly kind: 'harness:model';
  readonly alias: string;
  readonly modelId: string;
  readonly driver: ModelDriver;
  readonly accountPoolDef?: unknown;
  accountPool(pool: unknown): ClaudeModelDef;
}

export type AnthropicFetchTransport = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  },
) => Promise<{
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly json(): Promise<unknown>;
  readonly text(): Promise<string>;
}>;

export const claude: {
  cliAccount(id: string): ClaudeAccountSeat;
  account(id: string): ClaudeAccountSeat;
  model(
    alias: string,
    opts: { readonly id: string; readonly transport?: AnthropicFetchTransport },
  ): ClaudeModelDef;
};
```

### 3.2 `packages/openai/src/index.ts`

```ts
import type {
  AccountSeatDescriptor,
  EnvRef,
  ModelDescriptor,
  ModelDriver,
} from '@harness-dsl/core';

export type { AccountSeatDescriptor, ModelDescriptor };

export interface OpenAIAccountSeat extends AccountSeatDescriptor {
  readonly kind: 'openai:account-seat';
  readonly id: string;
  readonly configDirPath?: string;
  readonly apiKeyRef?: EnvRef | string;
  configDir(dirPath: string): OpenAIAccountSeat;
  apiKey(keyOrRef: EnvRef | string): OpenAIAccountSeat;
}

export interface OpenAIModelDef extends ModelDescriptor {
  readonly kind: 'harness:model';
  readonly alias: string;
  readonly modelId: string;
  readonly driver: ModelDriver;
  readonly accountPoolDef?: unknown;
  accountPool(pool: unknown): OpenAIModelDef;
}

export type OpenAIFetchTransport = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  },
) => Promise<{
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly json(): Promise<unknown>;
  readonly text(): Promise<string>;
}>;

export const openai: {
  account(id: string): OpenAIAccountSeat;
  codexAccount(id: string): OpenAIAccountSeat;
  model(
    alias: string,
    opts: { readonly id: string; readonly transport?: OpenAIFetchTransport },
  ): OpenAIModelDef;
};
```

### 3.3 `packages/gemini/src/index.ts` & `packages/gemini/src/driver.ts`

```ts
import type {
  AccountSeatDescriptor,
  EnvRef,
  ModelDescriptor,
  ModelDriver,
} from '@harness-dsl/core';

export type { AccountSeatDescriptor, ModelDescriptor };

export interface GeminiAccountSeat extends AccountSeatDescriptor {
  readonly kind: 'gemini:account-seat';
  readonly id: string;
  readonly configDirPath?: string;
  readonly apiKeyRef?: EnvRef | string;
  configDir(dirPath: string): GeminiAccountSeat;
  apiKey(keyOrRef: EnvRef | string): GeminiAccountSeat;
}

export type GeminiFetchTransport = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  },
) => Promise<{
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly json(): Promise<unknown>;
  readonly text(): Promise<string>;
}>;

export interface GeminiDriverOptions {
  readonly baseUrl?: string;
  readonly transport?: GeminiFetchTransport;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface GeminiModelOptions {
  readonly id: string;
  readonly effort?: 'low' | 'medium' | 'high';
  readonly baseUrl?: string;
  readonly transport?: GeminiFetchTransport;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface GeminiModelDef extends ModelDescriptor {
  readonly kind: 'harness:model';
  readonly alias: string;
  readonly modelId: string;
  readonly effort?: 'low' | 'medium' | 'high';
  readonly driver: ModelDriver;
  readonly accountPoolDef?: unknown;
  pool(pool: unknown): GeminiModelDef;
  accountPool(pool: unknown): GeminiModelDef;
}

export function createGeminiDriver(opts?: GeminiDriverOptions): ModelDriver;

export const gemini: {
  account(id: string): GeminiAccountSeat;
  cliAccount(id: string): GeminiAccountSeat;
  model(alias: string, opts: GeminiModelOptions): GeminiModelDef;
  createDriver(opts?: GeminiDriverOptions): ModelDriver;
};
```

---

## 4. Critical Implementation Invariants

### 4.1 `@harness-dsl/claude` Wire Invariants (`SPEC.md` §1.1 line 14, §2.5, §4.1 lines 1371–1375)

1. **Seat Credential Extraction, Run-Sticky Affinity & HTTP `429` Error Contract:**
   - `claude.cliAccount(id).configDir(path)` resolves `~` to `os.homedir()` and reads OAuth access token credentials from `<configDir>/.credentials.json` or `<configDir>/credentials.json` at invocation time; `.apiKey(envRef)` resolves `EnvRef` from `process.env[envRef.key]`.
   - When the transport returns HTTP `429`, `ModelDriver.invokeTurn` parses `resetAtMs` from `retry-after` / `anthropic-ratelimit-*-reset` headers and throws an `Error` carrying `{ status: 429, resetAtMs?: number }` so `@harness-dsl/core`'s `PoolScheduler` rotates seats for `'soonest-reset'` pool selection while maintaining run-sticky seat affinity per `runId` until a seat returns HTTP `429`.
2. **KV-Cache-Preserving `invokeTurn` & Native `output_config.format`:**
   - Constructs `/v1/messages` payload using `wirePrefix.systemPromptText` (with `cache_control: { type: 'ephemeral' }`) and `wireToolSchemas` from `req.wireToolSchemas ?? req.wirePrefix?.wireToolSchemasByRoleKey[req.roleKey ?? '*']`.
   - Whenever `req.outputSchema` is provided, sets `output_config: { format: { type: 'json_schema', schema: zodToJsonSchema(req.outputSchema) } }` so completion turns and `toolChoice: 'none'` epistemic flush turns never emit synthetic `tool_use` blocks.
   - When `req.toolChoice === 'none'`, keeps `tools` in the request payload intact (preserving byte 0 of the Anthropic KV prefix cache) and sets `tool_choice: { type: 'none' }`.
   - Populates `structuredOutput` (parsed and validated against `req.outputSchema`) if and only if `(!canonical.toolCalls || canonical.toolCalls.length === 0)` and `req.outputSchema` is defined.
   - Encodes the exact Anthropic message object (including `thinking` blocks and `signature` fields) into `rawWireFrame` (`TextEncoder`).
3. **`prepareFork` (`shared-prefix-only` vs `clone-transcript`, `substituteTombstones`, Full-Turn `(1..k)` Pairing):**
   - `'shared-prefix-only'`: returns a single `role: 'user'` `WireFrameRecord` containing `[ctx.childRoleContextFrameText, ctx.childTaskPromptText].filter(Boolean).join('\n\n')`.
   - `'clone-transcript'` with `target.substituteTombstones === false`: slices `ctx.parentChain` up to `ctx.forkPointMessageId`, keeping `rawWireFrame` (and all `thinking` blocks/signatures and un-tombstoned skill instructions) byte-for-byte intact while assigning forked `messageId`/`parentMessageId` links and injecting `cache_control: { type: 'ephemeral' }` at the fork boundary.
   - `'clone-transcript'` with `target.substituteTombstones === true`: slices `ctx.parentChain` up to `ctx.forkPointMessageId`, replaces any `tool_result` content whose `callId` is present in `frame.compactedTombstones` with `frame.compactedTombstones[callId]`, strips model-specific `thinking` / `redacted_thinking` blocks and `signature` fields, and reconstructs wire frames from `CanonicalMessage`—strictly omitting `{ type: 'text' }` blocks whenever `canonical.visibleText === ''` and `canonical.toolCalls?.length > 0`.
   - In **both** `substituteTombstones === false` and `substituteTombstones === true` branches of `'clone-transcript'`:
     - If `ctx.forkPointMessageId` is an `assistant` turn with `toolCalls` `(1..k)` and `ctx.forkCallId` is set, iterates all `toolCalls` `(1..k)` in declaration order and appends a single synthesized `role: 'tool'` `WireFrameRecord` pairing every `callId`: using `ctx.precedingCompletedResults` for `(1..m)`, `[ctx.childRoleContextFrameText, ctx.childTaskPromptText].filter(Boolean).join('\n\n')` for `ctx.forkCallId`, and `"[Dispatched/Deferred in parent turn]"` for all other `callId`s in that turn.
     - If `ctx.forkCallId` is not set (e.g., `H.loop` cross-model escalation at a user/assistant boundary) and `ctx.childRoleContextFrameText` or `ctx.childTaskPromptText` is provided, appends the user frame; when both are omitted (same-actor `H.loop` escalation), emits no extra user frame so `feedbackMapper(evalResult)` never creates consecutive `user` frames.
4. **Generalized `appendToolResultNotes` (`SPEC.md` §2.5 lines 419–429):**
   - If `frame.canonical.role === 'tool'`, locates the `tool_result` entry matching `targetCallId` (or the final `tool_result` entry if `targetCallId` is omitted), appends `\n\n${notes.join('\n')}` to its content, sets `isError = opts.isError` if `opts?.isError !== undefined`, and updates both `rawWireFrame` and `frame.canonical`.
   - If `frame.canonical.role === 'user'`, appends `\n\n${notes.join('\n')}` to the text content block in both `rawWireFrame` and `frame.canonical`.

### 4.2 `@harness-dsl/openai` Wire Invariants (`SPEC.md` §1.1 line 15, §2.5, §4.1 line 1376)

1. **Responses API, `text.format`, HTTP `429` Error Contract & Run-Sticky `previous_response_id`:**
   - Formats requests for OpenAI `/v1/responses` with `instructions: wirePrefix?.systemPromptText`, `tools`, `tool_choice: req.toolChoice ?? 'auto'`, and (when `req.outputSchema` is set) `text: { format: { type: 'json_schema', name: 'structured_output', strict: true, schema: zodToJsonSchema(req.outputSchema) } }`.
   - When the transport returns HTTP `429`, `ModelDriver.invokeTurn` parses `resetAtMs` from `retry-after` / `x-ratelimit-reset-*` headers and throws an `Error` carrying `{ status: 429, resetAtMs?: number }` so `PoolScheduler` rotates seats and records `resetAtMs`.
   - Tracks the originating `accountId` on each `WireFrameRecord`'s wire payload; when invoking a turn on the same `accountId` and same `modelId` where the parent frame carries a server `response_id`, transmits `previous_response_id` and delta input items.
   - Whenever failing over across distinct OpenAI seats (`frame.accountId !== currentAccountId`) or when `target.substituteTombstones === true` in `prepareFork`, automatically strips `previous_response_id`, server item IDs (`rs_...`, `fc_...`, `msg_...`), and `encrypted_content`, replaying clean `CanonicalMessage` input items + reasoning summary text.
2. **`prepareFork` & `appendToolResultNotes`:**
   - Mirrors the exact `'shared-prefix-only'` vs `'clone-transcript'` (`substituteTombstones: false` vs `true`), full-turn `(1..k)` `function_call_output` pairing when `ctx.forkCallId` is set, and generalized `appendToolResultNotes` (`tool` and `user` frames with `targetCallId` and `opts?: { isError?: boolean }`) contracts.

### 4.3 `@harness-dsl/gemini` Wire-Format & Fork Invariants (`SPEC.md` §1.1 line 16, §2.5, §4.1 lines 1377–1383)

1. **Seat Credential Extraction (`gemini.account` & `gemini.cliAccount`), HTTP `429` Rate-Limit Error Contract & Cross-Seat Failover:**
   - `gemini.account(id).apiKey(H.env('GEMINI_API_KEY'))` resolves `EnvRef` from `opts?.env ?? process.env` at invocation time and sends `x-goog-api-key: <apiKey>`; `gemini.cliAccount(id).configDir(path)` resolves `~` to `os.homedir()` and reads OAuth / ADC credentials from `<configDir>/oauth_creds.json`, `<configDir>/application_default_credentials.json`, or `<configDir>/credentials.json` (sending `Authorization: Bearer <accessToken>` when an OAuth access token is present, or `x-goog-api-key` when `apiKey` is configured).
   - Targets `${baseUrl}/v1beta/models/${encodeURIComponent(req.modelId)}:generateContent`.
   - When the transport returns HTTP `429`, `ModelDriver.invokeTurn` parses `resetAtMs` from `retry-after` / `x-ratelimit-reset` headers (or JSON error `RetryInfo` details) and throws an `Error` carrying `{ status: 429, resetAtMs?: number }` so `@harness-dsl/core`'s `PoolScheduler` rotates seats while maintaining run-sticky seat affinity per `runId` until HTTP `429` occurs, replaying the full `contents` array seamlessly across Gemini seats on failover.
2. **Prefix Wire Assembly (`systemInstruction` & `tools: [{ functionDeclarations }]`), `thinkingConfig`, `thoughtSignature` Preservation & Native `responseJsonSchema`:**
   - Translates `wirePrefix.systemPromptText` to `systemInstruction: { parts: [{ text: systemPromptText }] }`.
   - Translates `wireTools` (`req.wireToolSchemas ?? req.wirePrefix?.wireToolSchemasByRoleKey[req.roleKey ?? '*'] ?? req.wirePrefix?.wireToolSchemasByRoleKey['*']`) to `tools: [{ functionDeclarations: wireTools.map(t => ({ name: t.name, description: t.description, parametersJsonSchema: t.inputJsonSchema })) }]`.
   - Maps `req.toolChoice === 'none'` to `toolConfig: { functionCallingConfig: { mode: 'NONE' } }` while keeping `tools: [{ functionDeclarations }]` intact on the wire so epistemic flush turns (`LIMIT_EXCEEDED_FLUSH`) preserve prefix cache hits without emitting tool calls; maps `req.toolChoice === 'auto'` (or default when tools are present) to `toolConfig: { functionCallingConfig: { mode: 'AUTO' } }`.
   - Maps `effort` (`req.effort ?? modelOpts.effort`) to `generationConfig.thinkingConfig = { thinkingLevel: effort.toUpperCase(), includeThoughts: true }`.
   - Maps `req.outputSchema` to `generationConfig.responseMimeType = 'application/json'` and `generationConfig.responseJsonSchema = zodToJsonSchema(req.outputSchema)`, populating `structuredOutput` if and only if `(!canonical.toolCalls || canonical.toolCalls.length === 0)` and `req.outputSchema` is defined.
   - Enforces strict `user` / `model` role alternation in `contents`: `assistant` frames map to `role: 'model'` (preserving `thought: true` parts and cryptographic `thoughtSignature` fields on both `thought` and `functionCall` parts in `rawWireFrame`), and `tool` frames map to `role: 'user'` containing `functionResponse` parts (`{ functionResponse: { id: callId, name: toolName, response: isError ? { error: content } : { result: content } } }`).
3. **`prepareFork` (`shared-prefix-only` vs `clone-transcript`, `substituteTombstones`, Full-Turn `(1..k)` `functionResponse` Pairing) & `appendToolResultNotes`:**
   - `'shared-prefix-only'`: returns a single `role: 'user'` `WireFrameRecord` containing `[ctx.childRoleContextFrameText, ctx.childTaskPromptText].filter(Boolean).join('\n\n')`.
   - `'clone-transcript'` with `target.substituteTombstones === false`: slices `ctx.parentChain` up to `ctx.forkPointMessageId`, preserving `rawWireFrame` (`thought: true` parts and `thoughtSignature` fields on `thought` and `functionCall` parts, plus un-tombstoned skill payloads) intact.
   - `'clone-transcript'` with `target.substituteTombstones === true` (cross-model fork or escalation where `sourceModelId !== targetModelId`): slices `ctx.parentChain` up to `ctx.forkPointMessageId`, replaces any `functionResponse` content whose `callId` is present in `frame.compactedTombstones` with `frame.compactedTombstones[callId]`, and strips model-specific `thought: true` parts and `thoughtSignature` fields from `role: 'model'` contents (omitting empty `{ text: '' }` parts when `canonical.visibleText === ''` and `toolCalls` is non-empty).
   - In **both** `substituteTombstones === false` and `substituteTombstones === true` branches of `'clone-transcript'`, whenever `ctx.forkPointMessageId` is an `assistant` (`role: 'model'`) turn with `toolCalls` `(1..k)` and `ctx.forkCallId` is set, `prepareFork` iterates all `toolCalls` `(1..k)` in declaration order and appends a single synthesized `role: 'tool'` (`role: 'user'` on the Gemini wire) `WireFrameRecord` containing `functionResponse` parts for every `callId` `1..k` (using `ctx.precedingCompletedResults` for `(1..m)`, `[ctx.childRoleContextFrameText, ctx.childTaskPromptText].filter(Boolean).join('\n\n')` for `ctx.forkCallId`, and `"[Dispatched/Deferred in parent turn]"` for all other `callId`s in that turn). When `ctx.forkCallId` is not set and both `ctx.childRoleContextFrameText` and `ctx.childTaskPromptText` are omitted (same-actor `H.loop` escalation), emits no extra user frame.
   - `appendToolResultNotes(frame, notes, targetCallId, opts)`: on a `role: 'tool'` frame, appends `\n\n${notes.join('\n')}` to the matching `targetCallId` (or last) `functionResponse` part, sets `isError = opts.isError` when `opts?.isError !== undefined` (updating `functionResponse.response` to `{ error: content }` when `isError` is `true` or `{ result: content }` when `false`), and updates both `rawWireFrame` and `frame.canonical`; on a `role: 'user'` frame, appends `\n\n${notes.join('\n')}` to the `{ text }` part in both `rawWireFrame` and `frame.canonical`.

---

## 5. Required Test Suite (`packages/claude/test/*.test.ts`, `packages/openai/test/*.test.ts` & `packages/gemini/test/*.test.ts`)

1. **`claude-driver.test.ts`:**
   - `invokeTurn` with `CompiledWirePrefix` (`role-scoped` and `union`), `cache_control: { type: 'ephemeral' }`, native `output_config.format` JSON schema, `toolChoice: 'none'` preserving `tools` array on the wire, and `structuredOutput` populated only when `toolCalls` is empty.
   - `rawWireFrame` preserving `thinking` and `signature` fields across multi-turn sessions.
   - Seat credential loading from `configDir` vs `apiKey(H.env(...))` and `429` rate-limit reset tracking.
2. **`claude-fork-notes.test.ts`:**
   - `prepareFork` under `'shared-prefix-only'`.
   - `prepareFork` under `'clone-transcript'` with `substituteTombstones: false` (preserving `thinking` signatures and un-tombstoned skill frames) vs `substituteTombstones: true` (substituting per-`callId` `compactedTombstones`, stripping `thinking` blocks, and omitting empty `{ type: 'text' }` blocks when `visibleText === ''` and `toolCalls` is non-empty).
   - Full-turn `(1..k)` `tool_result` pairing across both `substituteTombstones: false` and `true` when `forkPointMessageId` has 3 `tool_use` blocks (`call_1` completed in `precedingCompletedResults`, `call_2` as `forkCallId`, `call_3` as sibling `[Dispatched/Deferred in parent turn]`).
   - Same-actor `H.loop` escalation omitting `childRoleContextFrameText` so no consecutive `user` frames are emitted.
   - `appendToolResultNotes` on `role: 'tool'` (targeting `targetCallId` vs last block, with `opts: { isError: true }`) and on `role: 'user'` frames.
3. **`openai-driver.test.ts` & `openai-fork-failover.test.ts`:**
   - `invokeTurn` with `text.format` JSON schema, `previous_response_id` reuse on same seat, and automatic stripping of `previous_response_id`, `rs_...`/`fc_...`/`msg_...` item IDs, and `encrypted_content` on cross-seat (`Seat A -> Seat B`) failover and cross-model (`substituteTombstones: true`) `prepareFork`.
   - Full-turn `(1..k)` `function_call_output` pairing in `prepareFork` across both `substituteTombstones: false` and `true`.
   - `appendToolResultNotes` across `role: 'tool'` and `role: 'user'` frames.
4. **`gemini-driver.test.ts`:**
   - `invokeTurn` translating `CompiledWirePrefix` (`systemInstruction` and `tools: [{ functionDeclarations }]` with `parametersJsonSchema`), `generationConfig.thinkingConfig` (`thinkingLevel` and `includeThoughts: true`), `generationConfig.responseMimeType: 'application/json'` and `generationConfig.responseJsonSchema`, and `toolChoice: 'none'` -> `toolConfig: { functionCallingConfig: { mode: 'NONE' } }` while preserving `tools` on the wire.
   - Multi-turn `rawWireFrame` preservation of `thought: true` parts and cryptographic `thoughtSignature` fields on both `thought` and `functionCall` parts, plus `role: 'user'` `functionResponse` correlation (`{ id, name, response: { result } | { error } }`).
   - `prepareFork` under `'shared-prefix-only'` and `'clone-transcript'` across both `substituteTombstones: false` (preserving `thought` parts and `thoughtSignature` fields) and `substituteTombstones: true` (substituting per-`callId` `compactedTombstones`, stripping `thought` parts and `thoughtSignature` fields, and omitting empty text parts), including full-turn `(1..k)` `functionResponse` pairing (`precedingCompletedResults`, `forkCallId`, and `[Dispatched/Deferred in parent turn]`) and same-actor `H.loop` escalation with omitted `childRoleContextFrameText`.
   - `appendToolResultNotes` across `role: 'tool'` (`functionResponse` targeting `targetCallId` or last part, with `opts: { isError: true }` updating `response.error`) and `role: 'user'` (`{ text }` part) frames.
   - `gemini.account` API key (`x-goog-api-key`) and `gemini.cliAccount` OAuth `configDir` (`Authorization: Bearer`) resolution, HTTP `429` `{ status: 429, resetAtMs }` error contract, and cross-seat failover.

---

## 6. Verification Gate Commands

```bash
pnpm check:comments
pnpm --filter @harness-dsl/claude typecheck
pnpm --filter @harness-dsl/claude test
pnpm --filter @harness-dsl/openai typecheck
pnpm --filter @harness-dsl/openai test
pnpm --filter @harness-dsl/gemini typecheck
pnpm --filter @harness-dsl/gemini test
```
