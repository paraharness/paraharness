# ours-2, cut

This child is the parent (g00-ours-2-1) with three changes:

- The surface is cut to what the battery calls.
- The adversary's three sharpest critiques are repaired.
- The per-harness quota share moves off the account, which fixes scenario 7.

The rest of the design is unchanged and is restated here so this file stands alone.

## Entities

### Kinds (vocabulary, no backend)

| Builder | Produces | Notes |
|---|---|---|
| `H.work(n).schema(z).states(...)` | `Work` | No supplier, store, handler, timer, key or failure move. |
| `H.state(n).pending() / active() / waiting() / terminal(verdict)` | `State<N, P>` | Shareable. Every terminal state declares a verdict, with no default. |
| `H.resource(n)` | `Resource` | `.exclusive()` and `.shared()` give lease claims. A section, a database or a file area is a resource. |
| `H.halt(n).context(z).decision(z).ask(fn)` | `Halt` | A named question. Its address in a flow is the step name it is placed under. |
| `H.memory(n).content(z).trust(t).curated()` | `MemoryKind` | |
| `H.role(n).prompt().intents().recall().record().use()` | `Role` | |
| `H.skill(n).input(z).output(z).prompt(fn)` | `Skill` | The typed contract for one model call. |
| `H.facet(n)` | `Facet` | A metric dimension that is not a column. `.is(v)` gives a `FacetValue<N>`. |

### Instances (carry a backend)

- **Account.** `H.account(n, driver).quota(partition)`. An account carries no share cap; that is per harness and lives on the pool.
- **Model.** `H.model(id).pricing(p)`.
- **Command.** `H.command(n).input().output().runner().effect().detect().run()`.
- **Job.** There are two ways to build one:
  - `H.job(n).input().output().submit(fn).collect(fn, every).detect(fn)` is the general external job.
  - `H.job(n).batch(seat)` is a batch of model calls, priced `batch`.
- **Runners** live in `harness-dsl/runners`.

### Pivots

- **Seat.** `H.seat(n).role().skill().models(...).policy()` is role × skill × models × choice policy. There is no separate agent noun.
- **Pool.** `H.pool(n, accounts).share(account, ratio).serves(...).policy().fallback()` is accounts × policy × per-harness shares.
- **Lane.** `H.lane(n).of(work)` is work kind × suppliers × store × handler.
  - Supply, storage and handling: `.from`, `.store`, `.handle(flow, { input?, exits, retry })`.
  - Limits and ordering: `.wip`, `.ceiling({ maxUsd, onExceed })`, `.order({ after })`.
  - Consequences: `create`, `move`, `pause`, `resume`.
- **Journal.** `H.journal(n).of(kind).store().recall()` is memory kind × store × recall.
- **Grant.** `H.grant(client, ...operations)` is client × operations.

### Execution

- **Flow.** `H.flow(n).input(z)` followed by these methods:
  - `.use`, `.resources`, `.tag`;
  - `.step`, `.halt`, `.when`, `.loop`, `.parallel`, `.spawn`, `.exit`.
- **Trigger.** `H.trigger(n).on(stream).do(...consequences)`.
- **Streams.** One vocabulary serves triggers, metrics and observers:
  - `H.events.*` and `H.time.*`;
  - `metric.crossing({...}).down / .up`;
  - `.where` and `.streak` refine any stream.
- **Metric.** `H.metric(n, stream).rate|mean|median|sum|count(...).by(...dims).window(w)`.
- **Policy.** `H.policy.accounts | models | units | recall | decision(...)`.
- **Harness.** `H.harness(n)` with `.ledger`, `.pools`, `.lanes`, `.journals`, `.triggers`, `.scheduler`, `.grants`, `.observe` and `.start()`.

## Rules

### Lifecycle

- **Attempt status.** An attempt is `running`, `blocked(reason)`, `suspended(job | children)` or `ended(outcome)`.
  - The blocked reasons are `decision`, `interrupted`, `definitionChanged` and `order`.
  - Blocked and suspended attempts hold no slot and no WIP. The board shows their unit at `waiting` with the reason.
- **What the scheduler sees.** `ScheduleChoice.active` lists every unit with a live attempt and carries its `status` (`running`, `blocked`, `suspended`). Only `running` entries hold capacity.
- **Exits.** A flow ends in an exit label, and the lane maps the label to one of the kind's states (compile-checked).
  - A target may be bounded: `{ to, atMost, then }`. The kernel counts the entries into `to` caused by that exit, and entry number `atMost+1` goes to `then` instead. The flow does no arithmetic.
- **Retry.** `retry: { retries, backoff?, exhausted }` is required on every lane.
  - **`exhausted` must be a terminal state or a waiting state of the kind** (enforced by type). It is never a pending state, so exhaustion cannot loop.
  - A failed attempt leaves the unit at pending until the retries are spent.
  - Something that must wait for a person is a blocked attempt, never a unit state.
- **Step retry.** `{ retry }` on a step retries that step inside one attempt.
- **Ordering.** `.order({ after })` holds a unit at pending until every key returned by `after` has a success verdict.
  - If one of those keys ends with a failure verdict, the unit's attempt opens and immediately **blocks with reason `order`**, carrying the failed key.
  - The supervisor restarts or abandons it through `H.ops.attempts.manage`.

### Moves

`lane.move(select, to)` is the only way anything outside a flow changes a unit's state. The kernel defines what happens from two facts: the target's position and the live attempt's status.

| Target | Attempt running | Attempt blocked or suspended | No live attempt |
|---|---|---|---|
| terminal | Cancelled now; unit moves. | Cancelled now; unit moves. | Unit moves. |
| non-terminal | Recorded as `move.deferred`; applied when the attempt next stops, with the selector re-evaluated then. | Cancelled; unit moves. | Unit moves. |

- A cancellation is never counted as a model or seat failure.
- **Selectors** take one of three forms:
  - a function from the event to a key;
  - `{ state, where(data, event) }`;
  - `{ halted, key? }`.

### Ceiling

- The ceiling halt's context and decision are kernel types: `CeilingFacts` and `CeilingDecision = { extraUsd }`.
- `extraUsd > 0` raises the unit's ceiling and continues the same attempt.
- `extraUsd = 0` fails the attempt with cause `budget`. A budget failure is not retried, and the unit moves to the lane's `retry.exhausted` state.

### Signals and time

- **Supplier updates.**
  - The default mode is `upsert`. Only the webhook exposes `mode`.
  - An update during a running attempt is recorded at once and delivered `deferred` when the attempt next stops.
  - A webhook's `data` receives the unit's current data as a second argument:
    - typed `T` in `update` mode (an update for an unknown key is ignored);
    - typed `T | undefined` otherwise.
  - The kernel provides the current data through `SupplySink.current`.
- **Deadlines.**
  - `H.time.at(lane, data => Date)` arms a timer on the ledger. Any update re-arms it and records `timer.superseded`.
  - `H.time.after(halt, d)` runs from the recorded `halt.opened`.
- **Resolvers.** Every resolution is recorded with its resolver:
  - a human, through a client granted `H.ops.resolve(halt)`;
  - a policy, a `DecisionPolicy` placed at the halt address;
  - the clock, `H.ops.resolve(halt).with(fn)` on an `H.time.after` stream.

### Metrics

- Every reading is `{ value, samples, window }`.
- **A metric key is a set of entity values, never strings.** `metrics.read(metric, ...at)` accepts only dimension values of the metric's declared dimensions. Omitted dimensions aggregate.
- **Crossings are per key.**
  - A crossing fires once per group key per crossing.
  - Hysteresis is kept per key, so a second `down` for one key needs an `up` first. This is the deduplication by group key (scenario 9).
  - Crossing events expose their key as `event.facet(category)`.
- **Decisions credit seats.** The kernel records on `halt.opened` the seats whose step outputs the context mapper read (`fed`). A decision metric keyed `.by('seat')` yields one sample per fed seat.
- **Command steps credit seats the same way.** A command step's record carries, in its `seat` and `model` columns, the seat (and the model that seat used in this attempt) whose output the step's input mapper read.
- **Success** comes only from terminal verdicts.

### Memory

- **Recording.** A role records with `record(kind)`, a trigger with `journal.record`, and a command with `ctx.remember`.
- **Curation.** Kinds marked `curated()` enter as candidates, and `H.ops.memory.curate` exposes accept, merge and drop.
- **Scope.**
  - Sections are resources. A flow's resource claims are part of the scope recall matches against.
  - Categories are facet values.

### Accounts across harnesses

- An account names its `QuotaPartition`. Every harness appends its own consumption and folds at read time.
- The share cap is `pool.share(account, ratio)` on each harness's own pool.
- One client descriptor granted in both harnesses is one supervisor session. `Client.serve` is called once per harness.

### Resumption

Resumption is replay over a memoizing ledger. The author writes none of it.

- **Completed steps.** An address that already completed (including each loop iteration's addresses) returns its recorded output at no cost.
- **The step running at the crash** is handled according to its kind:

  | Step | On restart |
  |---|---|
  | `repeatable` command | Rerun. |
  | `unrepeatable` command | Block with `interrupted`, unless `detect` finds the effect happened. |
  | `external` command | Ask `detect`. |
  | Seat | Ask the driver's `recover(session)`. |
  | Job | Collect by its recorded ref. A submit with no recorded ref asks `detect`, else blocks with `interrupted`. |

- **Definition changes.** A changed definition hash at or before the current address blocks the attempt with `definitionChanged`.
- **Single writer.** `Ledger.acquire` grants a single-writer lease. A live holder makes `start()` refuse. A stale holder is taken over, and the takeover is recorded.

### Startup validation (`start()` fails)

`start()` fails on any of the following:

- two descriptors of one entity sort with one name in a harness;
- an exit label with no mapping;
- a trigger, spawn or event on an unregistered lane;
- a recall kind with no journal, or two journals of one kind;
- a seat model that no pool serves, or a multi-model seat with no policy;
- a pool `share` naming an account not in the pool;
- a harness-shared account with no quota partition;
- a facet repeating a column name, or a `by` column absent from the stream's records;
- an `external` command without `detect`;
- a batch job whose seat's accounts have no `BatchDriver`;
- a resource listed in an agent plugin's `resources` that the plugin does not map;
- a halt referenced by a grant or timer that nothing places;
- a `{ halted }` selector naming a halt no flow of that lane places;
- a ceiling halt whose zod schemas do not parse `CeilingFacts` / `CeilingDecision`.

## What changed and why

### Critique repairs

1. **Retry exhaustion targets terminal states only.** This was loosened by change 14.
2. **`order` has no `failed` option.** An order failure blocks with reason `order`.
3. **Metric reads are keyed by entity values.** Decision events credit fed seats.
4. **`move` semantics are defined by target position × attempt status.**
5. **The ceiling decision is a kernel type** (`extraUsd`).

### Scenario 7

6. **The share cap moved from the account to the pool.**
7. **One client, two harnesses** is one session serving two control APIs.

### Surface cut

8. Builders, options and fields with no caller in the battery were removed.
9. Options every caller passes were made required.
10. `backoff` is optional on lane and step retry.

### Battery pass, scenarios 1–6

11. **`ActiveUnit.status` (kernel).** An open Incident blocked on a human is visible to the scheduling policy without holding capacity.
12. **Command steps credit fed seats.** This is scenario 3's citation-check pass rate per synthesizer model.
13. **Lease binding is required only for plugin-enforced resources.**

### Battery pass, scenarios 7–12

14. **`retry.exhausted` may be a waiting state** (`Settled<St>` replaces `Terminal<St>`).
    - Scenario 8's Tenancy is never terminal while the customer is a customer.
    - The old rule forced a monthly review that kept failing to end the tenancy in a terminal state. That is a lie, because the review failing does not end the customer relationship.
    - Principle 12 says the lane names where exhaustion leaves the unit "in the kind's own states". A waiting state satisfies that, and it cannot loop because waiting is not schedulable.
    - Pending targets stay forbidden by type.
15. **Webhook `data` receives the unit's current data.** This adds `SupplySink.current` in the kernel and splits `http.webhook` into an `update` overload (current is `T`) and an `upsert`/`create` overload (current is `T | undefined`).
    - Scenario 8's vendor replies and scenario 11's redlines carry only the change, not the whole unit.
    - Without the current data an update supplier must fabricate the fields it does not carry.
16. **No new entity for scenario 9's deduplication.** It is stated as a rule: hysteresis is held per crossing key.

## Principles broken

- **14 (bent, restated).** The memory envelope's `when` adds `facets` beside kinds, roles, skills and resources.
  - The bend is confined to genuinely open-ended values (classifier categories).
  - Fixed named things (sections, databases) are resources.

Otherwise none.
