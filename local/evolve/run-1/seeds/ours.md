# Seed: ours (the design as arrived at in conversation, 2026-11-01)

Materialize this design faithfully, then make it compile against the whole battery. Where the battery exposes a gap, prefer the smallest change that keeps every principle.

## Entities

Kinds (pure vocabulary):
- `H.work(name).schema(zod).states(...State).resources(unit => string[])` — a kind of work.
- `H.state(name).pending() | .active() | .succeeded() | .failed() | .cancelled()` — a named state mapped onto the skeleton; shareable across kinds.
- `H.memory(name).content(zod)` — a kind of memory item. The kernel adds the envelope: id, createdAt, `when: { kinds?, roles?, skills?, resources? }`.
- `H.role(name).prompt(text) | .promptFile(path) .tools([...]) .recall(...MemoryKind) .record(...MemoryKind) .use(...AgentPlugin)` — what an agent knows and may do.
- `H.skill(name).input(zod).output(zod).prompt(fn).assert(fn).maxRetries(n).handoffWhen(fn)` — a typed contract for one model call.

Instances (carry a backend):
- `H.account(name, driver).maxQuotaShare(r).quotaPolicy({...})`.
- `H.model(accountOrPool, modelId, options?).pricing(adapter)`.
- `H.runner.local({ slots }).env({ NAME: H.slot.port(0) | H.env('X') | 'literal' })`; `H.runner.ssh(name, {...})`.
- `H.command(name).input(zod).output(zod).runner(r).env({...}).run(async ({ input, exec, ctx }) => ...)`.

Pivots (named):
- `H.pool(name, [...accounts | ...models]).policy(policy).fallback(account)` — candidates × policy.
- `H.agent(name).role(role).model(modelOrPool)` — role × model.
- `H.lane(name).of(workKind).from(...suppliers).store(store?).handle(flow).wip(n)` — work kind × suppliers × store × handler. Suppliers and stores are separate interfaces; one adapter may be both; a lane with no store has no domain state (only the ledger).
- `H.journal(name).of(memoryKind).store(memoryStore).recall(policy)` — memory kind × store × recall policy.

Execution:
- `H.flow(name).input(zod).use(middleware).step(name, executable, mapInput?).when(pred, sub).branch(sel, map).parallel(map).loop({ maxIterations, body, until }).batch(name, { items, execute, concurrency }).haltIf(pred, blocker).transition(stateOrFn).spawn(name, lane, mapItems, { await? }).onError(fn).finally(fn)`.
- `H.trigger(name).on(lane.enters(state)).do(lane.add(mapper) | executable | journal.record(mapper))`.
- `H.policy(name, ({ candidates, metrics, unit, ... }) => ordered candidates)` — one entity for pool strategy, model choice, scheduling order, recall ranking.
- `H.scheduler().concurrency(n).policy(policy)`.
- `H.supervisor(name).client(client).grant(...operations).contextNotice(tokens).tool(name, executable)`; operations: `H.ops.work.read`, `H.ops.work.write`, `H.ops.blockers.resolve`, `H.ops.memory.write`, `H.ops.telemetry.read`, `H.ops.accounts.manage`, and `H.operation(name, executable)`.
- `H.harness(name).ledger(ledger).lanes(...).journals(...).triggers(...).scheduler(s).supervisor(sv).observe(...observers)`; `await harness.start()`.
- References: `H.env(name)`, `H.slot.port(n)`.

Adapters (subpaths, examples): `harness-dsl/claude-code` (`claudeCode.driver({ configDir })`, `claudeCode.client()`), `harness-dsl/anthropic` (`anthropic.api({ apiKey })`), `harness-dsl/sqlite` (`sqlite.ledger(path)`), `harness-dsl/jsonl` (`jsonl.store(path)`), `harness-dsl/linear` (`linear.supply({...})`, `linear.store({...})`), `harness-dsl/supply` (`folder(path)`, `schedule(cron, produce)`, `manual()`), `harness-dsl/policies` (`drainSoonestExpiring`, `byApplicability({ budgetTokens })`), `harness-dsl/observers` (`board(path)`, `telemetry(path)`), `harness-dsl/plugins` (`fileLeaseGuard()`, `gitWorktreeIsolation({...})`, `stopCommandHook(cmd, opts)`).

## Mechanics

- Lifecycle skeleton: pending, active, succeeded, failed, cancelled. Blocked is an attempt state.
- Ledger records runs, attempts, invocations, transitions (with attempt, actor, model), the pending queue, quota. Metrics are computed from transitions: `metrics.outcomes({ model?, kind?, actor?, window }) → { samples, successRate, costUsd }`.
- Recall: items filtered by `when`, ranked by specificity then track record (items injected into succeeded attempts rise), cut by token budget.
- Triggers fire only from recorded transitions; firings are recorded.

## Known weaknesses (see self-critique.md)

The seed is expected to fail scenarios 2 (time triggers, external cancellation, per-unit cost), 4 (pattern triggers, preemption, HTTP client), 7 (shared account state across ledgers) and 8 (non-binary outcomes, perpetual units, suppliers that update). Fix them with the smallest coherent additions and say what you added in `design.md`.
