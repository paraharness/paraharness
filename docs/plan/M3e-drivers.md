# Milestone M3e — `@harness-dsl/claude`, `@harness-dsl/openai` & `@harness-dsl/gemini` Model Driver Adapters

## 1. Scope & Ownership (`owned_dirs` & `forbidden_dirs`)

- **Milestone**: `M3e` (Wave 2 — Parallel Adapter Fan-Out `c`, depends on `M1`)
- **Packages**: `@harness-dsl/claude` (`packages/claude`), `@harness-dsl/openai` (`packages/openai`), and `@harness-dsl/gemini` (`packages/gemini`)
- **`owned_dirs`**:
  - `packages/claude/src/**`, `packages/claude/test/**`
  - `packages/openai/src/**`, `packages/openai/test/**`
  - `packages/gemini/src/**`, `packages/gemini/test/**`
- **`forbidden_dirs`**:
  - `packages/core/**`
  - `packages/{sqlite,postgres,fs,markdown,node,git,github,slack,stripe,netsuite,integration}/**`
  - Root workspace configs (`package.json`, `eslint.config.mjs`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`) and `docs/**`
- **Cross-Adapter Independence Rule**:
  - `@harness-dsl/claude`, `@harness-dsl/openai`, and `@harness-dsl/gemini` must have **zero runtime or type imports** from each other or from any other M3 adapter package. Each depends exclusively on `@harness-dsl/core` (`workspace:*`) and `zod`.

---

## 2. Normative Specification & Coding Sample Grounding

| Normative Source | Section & Exact Line Range | Grounded Scope in `M3e` |
| :--- | :--- | :--- |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §1.1–§1.2 (`lines 3–34`) | Pure passive AST nodes (`ClaudeAccountSeatNode`, `ClaudeModelNode`, `OpenAiAccountSeatNode`, `OpenAiModelNode`, `GeminiAccountSeatNode`, `GeminiModelNode`), zero network or env reads at builder time, and late-bound `EnvRef` resolution. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.6 (`lines 1506–1630`) | `CanonicalMessage`, `WireFrameRecord` (`rawWireFrame`, `canonical`, `compactedTombstones`), `WireToolSchema`, `CompiledWirePrefix` (`wireToolSchemasByRoleKey`), `ForkContext` (`historyMode`, `forkPointMessageId`, `forkCallId`, `precedingCompletedResults`, `childRoleContextFrameText`, `childTaskPromptText`), and `ModelDriver` (`invokeTurn`, `prepareFork`, `appendToolResultNotes`). |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §3.2.1, §3.4.2, §3.7.2, §3.8 (`lines 2135–2560`) | Prefix-group KV-cache stability, `compactedTombstones` substitution exclusively on cross-model escalations (`substituteTombstones: true`), full-turn `(1..k)` tool-call pairing in `prepareFork`, and `toolChoice: 'none'` epistemic flush turns preserving `wireToolSchemas`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §4.1 (`lines 2623–2676`) | Complete `@harness-dsl/claude`, `@harness-dsl/openai`, and `@harness-dsl/gemini` specifications: `claude.cliAccount(id).configDir(path)` / `.apiKey(envRef)`, `claude.account(id)`, `claude.model(alias, { id, effort? }).accountPool(pool)` / `.pool(pool)`; `openai.account(id)`, `openai.cliAccount(id)`, `openai.model(alias, { id, effort? }).accountPool(pool)` / `.pool(pool)`; `gemini.account(id)`, `gemini.cliAccount(id)`, `gemini.model(alias, { id, effort? }).pool(pool)` / `.accountPool(pool)`; vendor wire protocols, signature preservation/stripping, and `prepareFork` / `appendToolResultNotes` semantics. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §5 (`lines 3196, 3255`) | `claude.model('opus', { id: 'claude-opus-4-6' })`. |
| [`docs/CODING_SAMPLE.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_SAMPLE.md) | §6 (`lines 180, 324–343, 578, 722, 738, 758, 776, 849`) | `claude.cliAccount`, `claude.model(...).accountPool(...)` in `engineering-harness.ts`. |

---

## 3. Planned Module Decomposition & Public Exports

Every file in `packages/{claude,openai,gemini}/src/**` and `test/fixtures/**` adheres to [`docs/CODING_GUIDELINES.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_GUIDELINES.md) §1–§5 (`<= 250` lines per file, zero co-location of `interface` / `function` / `class` / `const` / `type`, strictly 1 top-level `interface` per file plus `TSPropertySignature` property sub-interfaces only, 1 `class` per file, 1 builder factory function per `create-*.ts` file, `internal/` helpers, pure `src/index.ts` barrels, full 3-part `/** ... */` JSDoc on every declaration and `TSMethodSignature`, and zero inline/non-JSDoc comments).

### 3.1 `packages/claude` (`@harness-dsl/claude`)

| File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `src/builders/claude-model-options.ts` | `interface` | `ClaudeModelOptions` |
| `src/builders/claude-account-seat-builder.ts` | `interface` | `ClaudeAccountSeatBuilder` |
| `src/builders/create-claude-account-seat-builder.ts` | `function` | `createClaudeAccountSeatBuilder` |
| `src/builders/claude-model-builder.ts` | `interface` | `ClaudeModelBuilder` |
| `src/builders/create-claude-model-builder.ts` | `function` | `createClaudeModelBuilder` |
| `src/builders/claude-namespace-contract.ts` | `interface` | `ClaudeNamespace` |
| `src/builders/claude-namespace.ts` | `const` | `claude: ClaudeNamespace` |
| `src/driver/claude-http-transport.ts` | `interface` | `ClaudeHttpTransport` |
| `src/driver/default-claude-http-transport.constants.ts` | `const` | `defaultClaudeHttpTransport: ClaudeHttpTransport` |
| `src/driver/internal/claude-wire-converter.ts` | `function` | `buildAnthropicMessagesRequest`, `parseAnthropicMessagesResponse`, `projectCanonicalToAnthropicMessage` |
| `src/driver/internal/claude-fork-and-notes.ts` | `function` | `prepareClaudeForkFrames`, `appendClaudeToolResultNotes` |
| `src/driver/claude-model-driver.ts` | `class` | `ClaudeModelDriver` (implementing `ModelDriver` with `vendorId: 'anthropic'`) |
| `src/driver/create-claude-executors.ts` | `function` | `createClaudeExecutors` |
| `src/driver/claude-executors.constants.ts` | `const` | `claudeExecutors: RuntimeExecutorRegistrySlice` |
| `src/index.ts` | `barrel` | Pure explicit re-exports of `claude`, `ClaudeNamespace`, `claudeExecutors`, `createClaudeExecutors`, `ClaudeModelDriver`, `ClaudeAccountSeatBuilder`, `ClaudeModelBuilder`, `ClaudeModelOptions`, `createClaudeAccountSeatBuilder`, `createClaudeModelBuilder`, `ClaudeHttpTransport`, `defaultClaudeHttpTransport`, `ClaudeAccountSeatNode`, `ClaudeModelNode` |

### 3.2 `packages/openai` (`@harness-dsl/openai`)

| File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `src/builders/openai-model-options.ts` | `interface` | `OpenAiModelOptions` |
| `src/builders/openai-account-seat-builder.ts` | `interface` | `OpenAiAccountSeatBuilder` |
| `src/builders/create-openai-account-seat-builder.ts` | `function` | `createOpenAiAccountSeatBuilder` |
| `src/builders/openai-model-builder.ts` | `interface` | `OpenAiModelBuilder` |
| `src/builders/create-openai-model-builder.ts` | `function` | `createOpenAiModelBuilder` |
| `src/builders/openai-namespace-contract.ts` | `interface` | `OpenAiNamespace` |
| `src/builders/openai-namespace.ts` | `const` | `openai: OpenAiNamespace` |
| `src/driver/openai-http-transport.ts` | `interface` | `OpenAiHttpTransport` |
| `src/driver/default-openai-http-transport.constants.ts` | `const` | `defaultOpenAiHttpTransport: OpenAiHttpTransport` |
| `src/driver/internal/openai-wire-converter.ts` | `function` | `buildOpenAiResponsesRequest`, `parseOpenAiResponsesOutput`, `stripOpenAiServerItemIdsAndEncryptedContent` |
| `src/driver/internal/openai-fork-and-notes.ts` | `function` | `prepareOpenAiForkFrames`, `appendOpenAiToolResultNotes` |
| `src/driver/openai-model-driver.ts` | `class` | `OpenAiModelDriver` (implementing `ModelDriver` with `vendorId: 'openai'`) |
| `src/driver/create-openai-executors.ts` | `function` | `createOpenAiExecutors` |
| `src/driver/openai-executors.constants.ts` | `const` | `openaiExecutors: RuntimeExecutorRegistrySlice` |
| `src/index.ts` | `barrel` | Pure explicit re-exports of `openai`, `OpenAiNamespace`, `openaiExecutors`, `createOpenAiExecutors`, `OpenAiModelDriver`, `OpenAiAccountSeatBuilder`, `OpenAiModelBuilder`, `OpenAiModelOptions`, `createOpenAiAccountSeatBuilder`, `createOpenAiModelBuilder`, `OpenAiHttpTransport`, `defaultOpenAiHttpTransport`, `OpenAiAccountSeatNode`, `OpenAiModelNode` |

### 3.3 `packages/gemini` (`@harness-dsl/gemini`)

| File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `src/builders/gemini-model-options.ts` | `interface` | `GeminiModelOptions` |
| `src/builders/gemini-account-seat-builder.ts` | `interface` | `GeminiAccountSeatBuilder` |
| `src/builders/create-gemini-account-seat-builder.ts` | `function` | `createGeminiAccountSeatBuilder` |
| `src/builders/gemini-model-builder.ts` | `interface` | `GeminiModelBuilder` |
| `src/builders/create-gemini-model-builder.ts` | `function` | `createGeminiModelBuilder` |
| `src/builders/gemini-namespace-contract.ts` | `interface` | `GeminiNamespace` |
| `src/builders/gemini-namespace.ts` | `const` | `gemini: GeminiNamespace` |
| `src/driver/gemini-http-transport.ts` | `interface` | `GeminiHttpTransport` |
| `src/driver/default-gemini-http-transport.constants.ts` | `const` | `defaultGeminiHttpTransport: GeminiHttpTransport` |
| `src/driver/internal/gemini-wire-converter.ts` | `function` | `buildGeminiGenerateContentRequest`, `parseGeminiGenerateContentResponse`, `stripGeminiThoughtPartsAndSignatures` |
| `src/driver/internal/gemini-fork-and-notes.ts` | `function` | `prepareGeminiForkFrames`, `appendGeminiToolResultNotes` |
| `src/driver/gemini-model-driver.ts` | `class` | `GeminiModelDriver` (implementing `ModelDriver` with `vendorId: 'google'`) |
| `src/driver/create-gemini-executors.ts` | `function` | `createGeminiExecutors` |
| `src/driver/gemini-executors.constants.ts` | `const` | `geminiExecutors: RuntimeExecutorRegistrySlice` |
| `src/index.ts` | `barrel` | Pure explicit re-exports of `gemini`, `GeminiNamespace`, `geminiExecutors`, `createGeminiExecutors`, `GeminiModelDriver`, `GeminiAccountSeatBuilder`, `GeminiModelBuilder`, `GeminiModelOptions`, `createGeminiAccountSeatBuilder`, `createGeminiModelBuilder`, `GeminiHttpTransport`, `defaultGeminiHttpTransport`, `GeminiAccountSeatNode`, `GeminiModelNode` |

---

## 4. Detailed Implementation Requirements

### 4.0 Strict File Separation & Full 3-Part JSDoc (`docs/CODING_GUIDELINES.md` §§1–2)
1. **Zero Co-Location of Entity Kinds**:
   - `interface`, `function`, `class`, `const`, and `type` declarations must **never** live in the same file in `packages/{claude,openai,gemini}/src/**` or `packages/{claude,openai,gemini}/test/fixtures/**`.
   - Every builder interface (`*-builder.ts`), options/transport interface (`*-options.ts`, `*-http-transport.ts`), and namespace contract (`*-namespace-contract.ts`) gets its own single-interface file; every builder factory function (`create-*.ts`) gets its own single-function file; every `ModelDriver` class and recorded transport fixture class gets its own single-class file; every `const` (`claude`, `openai`, `gemini`, `default*HttpTransport`, `*Executors`) lives in its own `const`-only file.
2. **Full 3-Part JSDoc Requirement**:
   - Every `interface`, `class`, `function`, class method, **interface method signature (`TSMethodSignature`)**, `type`, and exported `const` in `src/**` and `test/fixtures/**` must carry full 3-part JSDoc per `docs/CODING_GUIDELINES.md` §2 (2-paragraph Summary + Detailed description separated by a blank `*` line, vertically aligned `@template` and `@param {Type} name - Description`, and `@returns {Type} Description`), enforced by `pnpm --filter @harness-dsl/claude --filter @harness-dsl/openai --filter @harness-dsl/gemini lint`.

### 4.1 `@harness-dsl/claude` (`SPEC.md` §4.1 lines 2663–2667)
1. **Builders (`claude.*`)**:
   - `claude.cliAccount(id)` and `claude.account(id)` returning `ClaudeAccountSeatBuilder` with `.configDir(path)`, `.apiKey(envOrString)`, and `.toAST(): ClaudeAccountSeatNode` (`readonly type: 'claude:account-seat'`).
   - `claude.model(alias, { id, effort? })` returning `ClaudeModelBuilder` with `.accountPool(pool)`, `.pool(pool)`, and `.toAST(): ClaudeModelNode` (`readonly type: 'claude:model'`, `vendor: 'anthropic'`).
2. **`ClaudeModelDriver` (`RuntimeExecutorRegistry.models['claude:model']`)**:
   - Resolves seat authentication at turn invocation time: when `seat.configDir` is set (`claude.cliAccount(id).configDir(path)`), extracts the OAuth bearer credential from `configDir` (failing over to `.apiKey(envRef)` resolved via `ctx.resolveEnv` when `configDir` is absent or `.apiKey` is configured).
   - Uses `CompiledWirePrefix` (`systemPromptText` and `wireToolSchemasByRoleKey[roleKey]`) so top-level `system` and `tools` remain byte-identical across turns.
   - Enforces native JSON-schema structured output (`output_config.format: { type: 'json_schema', schema: zodToJsonSchema(outputSchema) }`) whenever `outputSchema` is provided.
   - Supports `toolChoice: 'auto' | 'none'` (preserving `wireToolSchemas` during epistemic flush turns).
   - Preserves exact Anthropic wire JSON (including `thinking` blocks and cryptographic `signature` fields) in `rawWireFrame`.
   - `prepareFork(ctx, target)`:
     - `'shared-prefix-only'`: starts a clean transcript after `CompiledWirePrefix` seeded with `ctx.childRoleContextFrameText`.
     - `'clone-transcript'` with `target.substituteTombstones === false`: replays `rawWireFrame` untouched up to `forkPointMessageId` with `cache_control: { type: 'ephemeral' }`.
     - `'clone-transcript'` with `target.substituteTombstones === true`: substitutes per-`callId` `compactedTombstones` on completed skill activation frames and projects `CanonicalMessage` frames (omitting `{ type: 'text' }` blocks whenever `canonical.visibleText === ''` and `toolCalls` is non-empty).
     - In **both** `substituteTombstones` branches of `'clone-transcript'`, when `ctx.forkCallId` is set on an `assistant` turn with `toolCalls` `(1..k)`, synthesizes a single `tool_result` wire frame pairing all `1..k` `callId`s (`precedingCompletedResults` for `1..m`, `childRoleContextFrameText` + `childTaskPromptText` for `forkCallId`, and `"[Dispatched/Deferred in parent turn]"` for all other `callId`s).
   - `appendToolResultNotes(frame, notes, targetCallId, opts)`: appends notes to `targetCallId` or the last `tool_result` block on `role: 'tool'` frames (setting `is_error: true` when `opts?.isError === true`), or to the text block on `role: 'user'` frames in both `rawWireFrame` and `frame.canonical`.

### 4.2 `@harness-dsl/openai` (`SPEC.md` §4.1 line 2668)
- `openai.account(id)` / `openai.cliAccount(id)` and `openai.model(alias, { id, effort? }).accountPool(pool)` / `.pool(pool)`.
- `OpenAiModelDriver` (`models['openai:model']`, `vendorId: 'openai'`):
  - Supports native JSON-schema structured output (`text.format: { type: 'json_schema', ... }`), `'shared-prefix-only'`, server-side `previous_response_id` branching on same-model `'clone-transcript'` forks (`substituteTombstones: false`), full-turn `(1..k)` `function_call_output` pairing in `prepareFork`, automatic stripping of `previous_response_id`, server item IDs (`rs_...`, `fc_...`, `msg_...`), and `encrypted_content` when `substituteTombstones === true` or when failing over across distinct OpenAI seats (`Seat A` $\to$ `Seat B`), `toolChoice: 'auto' | 'none'`, and `appendToolResultNotes`.

### 4.3 `@harness-dsl/gemini` (`SPEC.md` §4.1 lines 2669–2675)
- `gemini.account(id)` / `gemini.cliAccount(id)` and `gemini.model(alias, { id, effort? }).pool(accounts)` / `.accountPool(accounts)`.
- `GeminiModelDriver` (`models['gemini:model']`, `vendorId: 'google'`):
  - Maps `CompiledWirePrefix` to `systemInstruction` and `tools: [{ functionDeclarations }]`.
  - Preserves `thought: true` and `thoughtSignature` in `rawWireFrame` when `substituteTombstones === false`, and strips `thought` parts and `thoughtSignature` when `substituteTombstones === true`.
  - Enforces strict `user` / `model` role alternation, maps tool results to `functionResponse` with `{ error: content }` when `isError: true` and `{ result: content }` when `isError: false`, implements full-turn `(1..k)` `functionResponse` pairing in `prepareFork`, implements `appendToolResultNotes`, and maps `outputSchema` (`responseMimeType: 'application/json'`, `responseJsonSchema`), `effort` (`thinkingConfig: { thinkingLevel, includeThoughts: true }`), and `toolChoice` (`mode: 'NONE' | 'AUTO'`).

---

## 5. Deterministic Test Suite Architecture (`test/**` & `test/fixtures/**`)

All `test/fixtures/**` files strictly obey single-entity-kind file separation (1 `class` per file, `<= 250` lines per file, full 3-part §2 JSDoc):

| File Path | Line Ceiling | Required Deterministic Test Cases |
| :--- | :--- | :--- |
| `packages/claude/test/fixtures/recorded-claude-transport.ts` | `<= 250` | Single `class` (`RecordedClaudeTransport`) implementing `ClaudeHttpTransport`, capturing Anthropic `/v1/messages` payloads and returning scripted wire frames (including `thinking` + `signature` and `429` rate-limit responses). |
| `packages/claude/test/claude-driver.test.ts` | `<= 400` | Verifies `claude.*` builders, `claude.cliAccount(id).configDir(path)` OAuth credential extraction vs `.apiKey(envRef)` fallback, `invokeTurn` (`output_config.format` JSON schema, `toolChoice: 'none'` preserving `wireToolSchemas`, `thinking` signature preservation), `prepareFork` (`'shared-prefix-only'`, `'clone-transcript'` with `substituteTombstones: false` vs `true` omitting empty text blocks, and full-turn `(1..k)` `tool_result` pairing), and `appendToolResultNotes` across `'tool'` and `'user'` frames. |
| `packages/openai/test/fixtures/recorded-openai-transport.ts` | `<= 250` | Single `class` (`RecordedOpenAiTransport`) implementing `OpenAiHttpTransport` for OpenAI Responses API (`previous_response_id`, `rs_`/`fc_`/`msg_` IDs, `encrypted_content`). |
| `packages/openai/test/openai-driver.test.ts` | `<= 400` | Verifies `openai.*` builders, `invokeTurn`, `prepareFork` (full-turn `(1..k)` `function_call_output` pairing, stripping `previous_response_id`, server item IDs, and `encrypted_content` on `substituteTombstones: true` and cross-seat failover), and `appendToolResultNotes`. |
| `packages/gemini/test/fixtures/recorded-gemini-transport.ts` | `<= 250` | Single `class` (`RecordedGeminiTransport`) implementing `GeminiHttpTransport` for Gemini `/v1beta/models/{model}:generateContent` (`thought`, `thoughtSignature`, `functionCall`, `functionResponse`). |
| `packages/gemini/test/gemini-driver.test.ts` | `<= 400` | Verifies `gemini.*` builders, `invokeTurn` (`systemInstruction`, `functionDeclarations`, `thinkingConfig`, `responseJsonSchema`, `functionCallingConfig`, strict `user`/`model` role alternation, and `functionResponse` `{ error: content }` on `isError: true` vs `{ result: content }` on `isError: false`), `prepareFork` (preserving vs stripping `thought`/`thoughtSignature` and full-turn `(1..k)` `functionResponse` pairing), and `appendToolResultNotes`. |

---

## 6. Verification Gate Commands

Run from workspace root (plus the `IMPL_LOOP.md` `baseline_dirty` diff check against `<non_sibling_forbidden_dirs_excluding_upstream_patches>`):

```bash
pnpm --filter @harness-dsl/claude --filter @harness-dsl/openai --filter @harness-dsl/gemini lint
pnpm --filter @harness-dsl/claude --filter @harness-dsl/openai --filter @harness-dsl/gemini typecheck
pnpm --filter @harness-dsl/claude --filter @harness-dsl/openai --filter @harness-dsl/gemini test -- --reporter=verbose
test -z "$(git status --porcelain -- docs .agents .claude package.json tsconfig.base.json vitest.config.ts)"
```
