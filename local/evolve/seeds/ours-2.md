# Seed: ours-2 (the owner's design as ruled after run one, 2026-11-01)

Materialize this design faithfully, then make it compile against the whole battery. It is the design the owner intends to build; the loop judges it against the designs it evolved. Where the battery exposes a gap, prefer the smallest change that keeps every principle, and say what you changed in `design.md`.

## Entities

Kinds (pure vocabulary, no backend):
- `H.work(name).schema(zod).states(...State)` — a kind of work. It declares no supplier, store, handler, timer, key or failure move.
- `H.state(name).pending() | .active() | .waiting() | .terminal('success' | 'failure' | 'neutral')` — shareable across kinds; the position and the verdict are the skeleton's, the name is the owner's. A kind has at most one active state: where an active unit stands is its attempt's current step.
- `H.resource(name)` — a named shared thing (a file area, a database, a section, a host). Leases, memory scope and metric facets reference it by identity; what it maps to on disk or in a service is declared by the adapter that enforces it, never on the resource.
- `H.halt(name).ask(text | fn).decision(zod)` — a named question. Grants, timers, metrics and policies reference it by identity.
- `H.memory(name).content(zod).trust('experience' | 'taste')` — a kind of memory item. The kernel adds the envelope: id, created, `when: { kinds?, roles?, skills?, resources? }`, all entity references.
- `H.role(name).prompt(text) | .promptFile(path) .intents(['read', 'edit', 'shell']) .recall(...MemoryKind) .record(...MemoryKind) .use(...AgentPlugin)` — what an agent knows and may do; intents are mapped to tool names by the driver.
- `H.skill(name).input(zod).output(zod).prompt(fn).assert(fn).maxRetries(n)` — a typed contract for one model call.
- `H.facet(name)` — a metric dimension that is not a ledger column (a category, a region). A facet that repeats a column is a startup error.

Instances (carry a backend):
- `H.account(name, driver).maxQuotaShare(r).quota(partition)` — the partition (`sqlite.quota(path)`) is append-only quota events shared by every harness naming it; the ledger has no option for it.
- `H.model(modelId, options?).pricing(adapter)` — a model is not bound to an account or a pool; track record transfers.
- `H.runner.local({ slots }).env({ NAME: H.slot.port(0) | H.env('X') | 'literal' })`, `H.runner.ssh(name, {...})`.
- `H.command(name).input(zod).output(zod).runner(r).effect('repeatable' | 'unrepeatable' | 'external').detect(fn)?.run(fn)` — `effect` declares restart behaviour: rerun, never rerun (park for the supervisor), or ask `detect` whether it happened.
- `H.job(name).input(zod).output(zod).submit(fn → ref).collect(fn(ref) → output | pending)` — an external job: submitted now, collected later by poll or callback; holds no slot and no WIP while it runs; the ref is recorded at submission and collected, never resubmitted, after a restart.

Pivots (named):
- `H.pool(name, [...accounts]).serves(...models).policy(policy).fallback(account)` — accounts × policy, and the models they can serve; an agent whose model no registered pool serves fails at `start()`.
- `H.seat(name).role(role).models(...models).policy(policy)` — a role held by the model a deterministic policy picks at attempt time; metrics on an A/B pair key on the seat. `H.agent(name).role(role).model(model)` is a seat with one model.
- `H.lane(name).of(workKind).from(...suppliers).store(store?).handle(flow).exits({ label: State }).retry({ tries, backoff, exhausted: State }).wip(n).ceiling({ maxUsd, onExceed: Halt })` — work kind × suppliers × store × handler. The exit map and the retry bound are compile-checked against the kind's states. Suppliers declare unit identity (`linear.supply({...}).key(issue => issue.id)`); a supplier may create a unit or update one by key.
- `H.journal(name).of(memoryKind).store(memoryStore).recall(policy)` — memory kind × store × recall policy.
- `H.grant(client, ...operations)` — operations include `H.ops.resolve(Halt)`, `H.ops.work.read`, `H.ops.work.write`, `H.ops.memory.curate`, `H.ops.telemetry.read`, `H.ops.accounts.manage`, `H.operation(name, executable)`.

Execution:
- `H.flow(name).input(zod).use(middleware).step(name, executable, mapInput?, { retry? }).when(pred, sub).branch(sel, map).parallel(map).loop({ maxIterations, body, until }).batch(name, { items, execute }).halt(Halt, mapAsk).spawn(name, lane, mapItems).exit(label)` — a flow names no state; it ends in an exit the lane maps. `ctx.now` is a recorded value; `ctx` is frozen; steps share no scope.
- `H.trigger(name).on(source).do(consequence)` — sources: `lane.enters(State)`, `lane.exits(State)`, `lane.streak(State, n)`, `H.time.at(fn)` and `H.time.every(cron)`, `H.metric(...).crossing({ below, above, samples, window, by: Facet | column })`, `H.signal(name)`, `halt.open(Halt).after(duration)`; consequences: `lane.create(mapper)`, `lane.pause(reason)`, `lane.resume()`, `journal.record(mapper)`, `H.ops.resolve(Halt).with(decision)`, `unit.cancel()`, any executable. Triggers fire only from recorded ledger events; firings are recorded with the metric value.
- `H.policy(name, ({ candidates, metrics, unit, ... }) => ordered candidates)` — one entity for pool strategy, model choice, scheduling order, recall ranking and halt skips; every read is recorded with its sample count.
- `H.scheduler().policy(policy)`; `H.supervisor(name).client(client)` with grants; `H.harness(name).ledger(ledger).lanes(...).journals(...).triggers(...).scheduler(s).supervisors(...).observe(...observers)`; `await harness.start()`.
- References: `H.env(name)`, `H.slot.port(n)`.

Adapters (subpaths, examples): `harness-dsl/claude-code` (`claudeCode.driver({ configDir })`, `claudeCode.client()`), `harness-dsl/anthropic` (`anthropic.api({ apiKey })`, `anthropic.batch()`), `harness-dsl/sqlite` (`sqlite.ledger(path)`, `sqlite.quota(path)`, `sqlite.store(path)`), `harness-dsl/jsonl`, `harness-dsl/pgvector`, `harness-dsl/linear`, `harness-dsl/http` (`http.client()`, `http.webhook()`), `harness-dsl/supply` (`folder`, `schedule`, `manual`, `poll`), `harness-dsl/policies`, `harness-dsl/observers` (`board`, `telemetry`, `slack`), `harness-dsl/plugins` (`fileLeaseGuard({ [resource.name]: globs })`, `gitWorktreeIsolation`, `stopCheck`).

## Mechanics

- Lifecycle as principle 12 now stands: attempts succeed, fail or are cancelled; units are pending, active, waiting or terminal; terminal states carry verdicts; a failed attempt leaves the unit pending under the lane's retry, whose bound names the exhaustion state.
- Blocked is an attempt state with one meaning and five reasons: `decision`, `stepFailure`, `budget`, `interrupted`, `definitionChanged`. A blocked attempt holds no slot and no WIP. A halt is resolved by a human, a registered policy, or a clock; deadlines run from the recorded halt.
- Resumption by replay over a memoizing ledger: every step has a stable address; recorded results return at no cost; the step running at the crash is handled by its `effect` or its driver's `recover`; a resumed attempt is the same attempt; a changed definition parks the attempt with `definitionChanged`; the ledger has a single-writer instance lock.
- Signals: a supplier updates a unit by key; an event arriving mid-attempt is deferred to the next round, never dropped and never fatal; cancellation is a signal.
- The ledger is the kernel's only state; the quota partition is one of its partitions, append-only, named by the account.
- Metrics are computed from ledger transitions with sample counts; dimensions are typed columns or declared facets.

## Known weaknesses (see self-critique.md)

The owner expects this seed to be weakest where two nouns overlap (seat and agent; job and batch; halt entity and step name) and where resources map to adapters. Fix what the battery forces and say what you fixed.
