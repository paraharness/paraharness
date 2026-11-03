# ours-2, materialized: the source rename

The child of g00-ours-2-1. The operator is **rename**.

The weakest noun in the parent was **`Stream`**. Principle 13 already names it: "a trigger connects a *source* … to a *consequence*". The parent then invented a second word for the same thing and used it for triggers, metrics and observers alike. A first-time reader also expects a stream to be live and in-memory. What the parent's `Stream` actually denotes is a *selection of recorded ledger facts* that a trigger fires from, a metric folds over, or an observer reports.

So `Stream` becomes **`Source`**, and the trigger builder's intermediate `TriggerSource` becomes `TriggerDraft`. Principle 22 is now satisfied: one word, the principle's word.

The rest of the child repairs the adversary's three named defects, plus the scenario-7 surface defect behind the worst-scenario finding.

## Entities

### Kinds (vocabulary, no backend)

| Builder | Produces | Notes |
|---|---|---|
| `H.work(n).schema(z).states(...)` | `Work<N,T,St>` | No supplier, store, handler, timer or failure move. |
| `H.state(n).pending()/active()/waiting()/terminal(verdict)` | `State` | Shareable. Every terminal state declares its verdict. Every waiting state must have a declared way out (see Rules). |
| `H.resource(n)` | `Resource` | `.exclusive()` and `.shared()` produce lease claims. |
| `H.halt(n).context(z).decision(z).ask(...)` | `Halt` | A named question. Its address in a flow is the step name it is placed under. |
| `H.memory(n).content(z).trust(t).curated()` | `MemoryKind` | |
| `H.role(n)…` | `Role` | |
| `H.skill(n).input().output()…` | `Skill` | |
| `H.facet(n)` | `Facet<N>` | `.is(v)` gives a `FacetValue<N>`, used both as a scope value and as a metric read key. |

**Column-valued entities.** The entities that occupy a typed ledger column carry `dimension: <column>`:

- state, work kind (`kind`), resource, halt, account, model, seat, lane.

Each of them is its own read key for a metric.

### Instances (carry a backend)

- **Account.** `H.account(n, driver).quota(partition)`. An account carries no share cap; the cap moved to the pool.
- **Model.** `H.model(id).pricing(p)`.
- **Command.** `H.command(n)…`.
- **Job.** `H.job(n)…`, or `H.job(n).batch(seat)` for a batch of model calls.
- **Runners.** Live in `harness-dsl/runners`.

### Pivots (named)

- **Seat.** Role × skill × models × choice policy. There is no `H.agent`.
- **Pool.** `H.pool(n, accounts).serves(...models).maxQuotaShare(ratio, ...accounts?).policy(p).fallback(a)` is accounts × policy × share caps.
  - The share cap is a per-harness relationship, so it lives on the per-harness pivot.
  - With no accounts listed, the ratio applies to every account in the pool.
- **Lane.** Work kind × suppliers × store × handler.
- **Journal.** Memory kind × store × recall.
- **Grant.** Client × operations.

### Execution

- **Flow.** Unchanged.
- **Trigger.** `H.trigger(n).on(source).do(...consequences)`.
- **Source.** One vocabulary serves triggers, metrics and observers:
  - `H.events.*` and `H.time.*`;
  - `metric.crossing(...).down` and `.up`;
  - refinements on any source: `source.where`, `source.streak` and **`source.credit`**.
- **Metric.** `H.metric(n, source)…`.
  - A policy reads it with `metrics.read(metric, ...at)`, where every `at` is a typed dimension value.
  - A harness registers it with `harness.metrics(...)`.
- **Policy, consequences, harness.** As in the parent.

## Rules

Only the rules that changed are listed in full. All others stand as in the parent.

### Typed read keys (repairs critique b)

`MetricsReader.read(metric, ...at)` takes dimension values, not a record of strings. A dimension value is one of:

- a `FacetValue<N>`, from `facet.is(v)`;
- a column-valued entity (`sonnet`, `reviewerA`, `contractsEu`, …).

**The key is checked at compile time.** Its type is `DimensionValue<NoInfer<Key>>`, where `Key` is the union of dimensions given to `.by(...)`.

- Reading a metric by a facet it is not keyed on is a compile error.
- Renaming a facet changes `Key`, so every stale read site fails to compile. A read no longer silently returns an empty series.

The kernel receives `DimensionKey { dimension, value }[]`.

### Credit on a seat (repairs critique b, scenario 6)

`source.credit(seats, (event, seat) => boolean)` fans each event into one `CreditEvent` per seat. Each `CreditEvent` carries two columns, which the kernel fills from the ledger:

- `seat`;
- `model`: the model that seat actually ran in that event's attempt.

`H.metric(...).rate(e => e.credited).by('seat')` is therefore keyed on the seat. A policy reads it with `metrics.read(actedOn, reviewerA)`.

The editor's decision schema may still label critiques the way the editor sees them. The mapping from label to seat lives in one `credit` function, and the series survives a model swap, as principle 8 requires.

### Moves never kill a running step (repairs critique c)

`lane.move(select, to)` records one fact, `unit.moved` with cause `trigger` or `operator`. The parent's four uses are distinguished by the state the attempt is in, which the kernel owns:

| Live attempt at move time | Effect |
|---|---|
| None (pending, waiting, terminal-to-pending) | The unit moves. This covers reopen and wake. |
| `blocked` or `suspended` (holds no capacity) | The attempt ends `cancelled`, then the unit moves. This covers cancel and re-entry. |
| `running` | Recorded as `unit.moveDeferred`. It is applied when the attempt next stops: it blocks, suspends or ends. A running step is never interrupted by a move. |

In scenario 2, a customer reply during `classify` no longer kills classification. The reply is delivered as a deferred update, the move is applied when the attempt reaches the approval halt, and the draft is cancelled there.

A cancellation is never a model or seat failure.

### Ceiling decisions are kernel-owned (repairs critique c)

`lane.ceiling({ maxUsd, onExceed, context, stopped })` requires `onExceed` to be a halt whose decision type extends `CeilingDecision`, which has two cases:

| Decision | Effect |
|---|---|
| `{ action: 'raise', extraUsd }` | The ceiling for this unit rises by `extraUsd`, and the same attempt continues. |
| `{ action: 'stop' }` | The attempt ends `cancelled` (budget, not failure). The unit moves to `stopped` with cause `ceiling`. |

The meaning no longer depends on the author's schema. A halt with any other decision type does not compile at `.ceiling`.

### Waiting states need a declared way out (repairs critique a)

Principle 12 stands. Exhaustion is named on the lane, in the kind's own states. The parent let that requirement manufacture dead-end waiting states.

The child adds a startup rule: **a waiting state that some lane can enter must have at least one declared way out**. A way out is one of:

- a trigger `move` whose selector can select units in that state on that lane. This means a `{ state }` selector naming it, a key selector on that lane, or a `{ halted }` selector;
- a grant of **`H.ops.work.move(state)`**, which lets a named client move units out of that state.

`H.ops.work.write` does not count. Releasing a parked unit is an operation the grant must name, so the supervisor's power over it is explicit.

The board distinguishes waiting units by two fields on `BoardUnit`:

- `enteredBy`: the transition cause (`exhausted`, `order`, `exit`, …);
- `wokenBy`: the triggers and grants that can move the unit out.

So "awaiting vendor (woken by vendor-replied)" and "exhausted (woken by operator)" no longer look alike. Where a kind has an honest terminal failure state, exhaustion should target it. A waiting exhaustion target is now a declared choice with a named exit, not a sink.

### Registered metrics (added while writing scenarios 7 to 12)

`harness.metrics(...metrics)` registers the metrics that policies read and that `H.ops.telemetry.read` exposes.

- A policy is an opaque closure, so the kernel cannot discover the metrics it reads at startup.
- A metric that only the operator or an auditor queries (scenario 11's median time to decision, scenario 12's lock wait) is referenced by nothing else. Without registration it would be unreachable.
- A metric whose `crossing` feeds a registered trigger is registered implicitly.

How these surface:

- A policy that reads an unregistered metric gets a policy error. The error is recorded on the ledger as `policy.decided`, naming the metric.
- Two registered metrics with one name are a startup error.

### Scenario 7 surface (worst-scenario repair)

- **Share caps.** They live on the pool: `pool.maxQuotaShare(0.6)` in harness A and `pool.maxQuotaShare(0.3)` in harness B.
  - The shared module exports *underived* account descriptors: one name, one descriptor, imported by both harnesses.
  - No derivation is renamed or duplicated, so principle 11 holds.
  - Pools take per-harness names.
- **The owner's single supervisor session.** It is one exported client descriptor, granted in both harnesses' grants.
  - Each harness serves its own control API.
  - The client adapter attaches the one session to both endpoints.
  - `H.ops.accounts.manage` returns the partition fold. That fold includes `byHarness`, so either endpoint shows both harnesses' consumption.
  - No new entity is needed: a client is already an instance with a transport.

### Startup validation (`start()` fails)

The parent's list stands, plus:

- a waiting state with no declared way out;
- `H.ops.work.move(state)` naming a state no registered lane's kind has;
- a `credit` seat that the credited source's attempts never run;
- an account with a share cap in more than one pool of one harness;
- two registered metrics with one name.

The two compile-time checks above are enforced by types: a metric read key outside the metric's dimensions, and a ceiling halt with a non-`CeilingDecision` decision.

## What changed and why

1. **`Stream` renamed to `Source`, and `TriggerSource` to `TriggerDraft`.** This is the operator's change, made because principle 13 names it source (principles 19 and 22).
   - Everything that touched it was adjusted: `H.events.*`, `H.time.*`, `Hysteresis.down/up`, `H.trigger().on`, `H.metric`, and `observers.slack({ on })`.
2. **Metric reads take typed dimension values.** This repairs critique b, where a string stood in for a facet.
   - Column-valued entities gained `dimension`.
   - `Facet.is` returns `FacetValue<N>`.
   - `Metrics.read` in the kernel takes `DimensionKey[]`.
3. **`source.credit(seats, fn)` and `CreditEvent`.** Owner-defined A/B metrics key on the seat, not on parallel call labels (critique b, principle 8).
4. **Moves defer while a step runs**, recorded as `unit.moveDeferred`. This repairs critique c, the silent cancel of a running classify.
5. **The ceiling takes a kernel-typed decision and a `stopped` state**, with `CeilingDecision` in the kernel and cause `ceiling` (critique c).
6. **Waiting states need a declared way out.** This adds `H.ops.work.move(...states)` and the `BoardUnit.enteredBy/wokenBy` fields (critique a).
7. **`maxQuotaShare` moved from `Account` to `Pool`.** It is a per-harness relationship (principle 10), and the move removes the scenario-7 duplicate-name break of principle 11.
8. **Policy choices expose `seat: AnySeat`, not `seat: string`.** A policy can now read seat-keyed metrics with the entity.
9. **`Harness.metrics(...)`** was added while writing scenarios 7 to 12. Scenarios 11 and 12 ask for metrics no policy or trigger reads; the operator and the auditor query them through `telemetry.read`.
   - The parent had no way to name such a metric to the harness.
   - Metrics read inside policy closures cannot be discovered at startup, so they are registered rather than inferred.
   - This is one method on an existing entity. No new noun is added (principle 21).

**Not adopted: the adversary's proposed scenario 13** (lane-scoped resolvers, quorum).

- It is not in the battery, and principle 21 removes methods nobody in the battery calls.
- The natural extension is noted here for when it is ruled: `H.ops.resolve(halt).in(...lanes)` for scoped grants, and a `quorum` option on the halt placement.

**Notes from writing scenarios 7 to 12, with no surface change:**

- **Scenario 7, shared module.** The shared module is expressed as an exported `shared` object inside the one scenario file, because a scenario is one file. Both harnesses reference that object's descriptors by identity.
- **Scenario 8, vendor webhook.** The vendor webhook posts the negotiation's full public record, so an `update`-mode supplier can deliver a complete `Child<T>`. A patch-shaped update would need `SupplySink.patch`, which no scenario requires yet.
- **Scenario 9, one open Audit per category.** This holds because a hysteresis `down` crossing cannot fire twice without an `up` between them, and the `up` cancels the open Audit. The unit key is therefore per crossing.
- **Scenario 12, GPU job step.** The GPU job's `submit` and `collect` are the two halves of one job step, named `evaluate`.

## Principles broken

- **14 (bent, restated).** The envelope's `when` lists kinds, roles, skills, resources *and facets*.
  - Principle 14 still enumerates only kinds, roles, skills and resources.
  - Scenarios 6 and 9 still need items scoped to an open-ended data value (section, category).
  - Declaring every category as a resource entity would turn data into vocabulary. The parent's reason holds against the current text.

Otherwise none.
