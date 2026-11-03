# ours-2, materialized

The owner's ruled design (2026-11-01), made to compile against the twelve-scenario battery. Where the brief left a choice open I took the less obvious option; each one is listed under *What changed and why*.

## Entities

### Kinds (vocabulary, no backend)

| Builder | Produces | Notes |
|---|---|---|
| `H.work(n).schema(z).states(...)` | `Work<N,T,St>` | No supplier, store, handler, timer, key or failure move. |
| `H.state(n).pending()/active()/waiting()/terminal(verdict)` | `State<N,P>` | Shareable. Every terminal state declares a verdict. A kind has at most one active state. |
| `H.resource(n)` | `Resource` | `.exclusive()` / `.shared()` produce lease claims. |
| `H.halt(n).context(z).decision(z).ask(...)` | `Halt<N,C,D>` | A named question. Its address in a flow is the step name it is placed under. |
| `H.memory(n).content(z).trust(t).curated()` | `MemoryKind<N,C>` | `curated()` means recorded items enter as candidates. |
| `H.role(n).prompt().intents().recall().record().use()` | `Role` | The driver maps intents to tool names. |
| `H.skill(n).input(z).output(z).prompt().assert().maxRetries()` | `Skill<N,I,O>` | The typed contract for one model call. |
| `H.facet(n)` | `Facet` | A dimension that is not a column. `.is(v)` gives a scope value. |

### Instances (carry a backend)

- **Account.** `H.account(n, driver).maxQuotaShare(r).quota(partition)`.
- **Model.** `H.model(id, opts).pricing(p)`. A model is not bound to an account, so its track record transfers between accounts.
- **Command.** `H.command(n).input().output().runner(r | input => r).effect(e).detect(fn).run(fn)`. A command with no runner runs in-process.
- **Job.** There are two ways to build one:
  - `H.job(n).input().output().submit(fn).collect(fn).every(d).detect(fn)` is the general external job.
  - `H.job(n).batch(seat)` is a batch of model calls. Its submit and collect come from the account driver's `BatchDriver`, and it is priced `'batch'`.
- **Runners** are adapters. `harness-dsl/runners` provides `local` and `ssh`, each with `.env()` and `.preflight()`.

### Pivots (named)

- **Seat.** `H.seat(n).role(r).skill(s).models(...m).policy(p)` is role × skill × models × choice policy. A seat with one model needs no policy. **There is no `H.agent`.**
- **Pool.** `H.pool(n, accounts).serves(...models).policy(p).fallback(a)` is accounts × policy.
- **Lane.** `H.lane(n).of(work)` is work kind × suppliers × store × handler. Its methods:
  - `.from(...)` and `.store(s?)` say who supplies the unit and where it is stored;
  - `.handle(flow, { input?, exits, retry })` says what handles it;
  - `.wip(n)`, `.ceiling({ maxUsd, onExceed, context })` and `.order({ after, failed })` set limits and ordering.
- **Journal.** `H.journal(n).of(kind).store(ms).recall(p)` is memory kind × store × recall.
- **Grant.** `H.grant(client, ...operations)` is client × operations. **There is no `H.supervisor`.** A supervisor is whichever client holds grants.

### Execution

- **Flow.** `H.flow(n).input(z)` followed by these methods:
  - `.use`, `.resources`, `.tag`;
  - `.step`, `.halt`, `.when`, `.loop`, `.parallel`, `.spawn`, `.exit`.
- **Trigger.** `H.trigger(n).on(stream).do(...consequences)`.
- **Streams.** One vocabulary serves triggers, metrics and observers:
  - `H.events.*`: transitions, attempts, steps, invocations, decisions, jobs, leases, pauses and updates;
  - `H.time.*`: every, at and after;
  - `metric.crossing(...)`: `.down` and `.up`;
  - `stream.where(...)` and `stream.streak(n, { group, matches })` refine any stream.
- **Metric.** `H.metric(n, stream).rate|mean|median|sum|count(...).by(...dims).window(w)`.
- **Policy.** `H.policy.accounts|models|units|recall|decision(...)` is one entity, typed by the site it serves.
- **Consequences:**
  - `lane.create(child, facets?)`, `lane.move`, `lane.pause`, `lane.resume`;
  - `journal.record`;
  - `H.ops.resolve(halt).with(fn)`;
  - `H.call(exe, map)`.
- **Harness.** `H.harness(n)` with `.ledger`, `.pools`, `.lanes`, `.journals`, `.triggers`, `.scheduler(policy)`, `.grants`, `.observe` and `.start()`.

## Rules

### Lifecycle

- **Attempt status.** An attempt is `running`, `blocked(reason)`, `suspended(job | children)` or `ended(outcome)`.
  - The blocked reasons are `decision`, `stepFailure`, `budget`, `interrupted` and `definitionChanged`.
  - Blocked and suspended attempts hold no slot and no WIP. The board shows their unit at `waiting`.
- **Exits.** A flow ends in an exit label, and the lane maps the label to one of the kind's states (compile-checked).
  - A target may be bounded: `{ to, atMost, then }`. The kernel counts the entries into `to` caused by that exit, and entry number `atMost+1` goes to `then` instead.
- **Retry.** `retry` is required on every lane, so exhaustion always names a state. A failed attempt leaves the unit at pending until the retries are spent. Then the unit moves to `exhausted`.
- **Step retry.** `{ retry }` on a step retries that step inside one attempt.
- **Step failure.** `{ onFailure: 'block' }` blocks the attempt with `stepFailure` instead of failing it.
- **Moves.** `lane.move(select, to)` is the only way anything outside a flow changes a unit's state. If the unit has a live attempt, that attempt ends `cancelled`. A cancellation is never counted as a model or seat failure.
  - A selector is one of three things:
    - a function from the event to a unit key;
    - `{ state, where(data, event) }`;
    - `{ halted, key(event) }`, which picks units whose attempt is blocked at that halt, narrowed to one key.
- **Ordering.** `.order({ after, failed })` holds a unit at pending until every key returned by `after` has a success verdict. If any of those keys ends with a failure verdict, the unit moves to `failed` with cause `order`.
- **Ceiling.** `.ceiling({ maxUsd, onExceed, context })` halts the attempt at `onExceed` before a step that would pass `maxUsd`.

### Signals and time

- **Supplier updates.** A supplier offers `{ key, data }`. Its `mode` is one of `create`, `update` or `upsert`.
  - When a unit's attempt is running, an update is recorded at once. Its `UpdateEvent` is delivered (`deferred: true`) when the attempt next stops running. The update is never dropped and never fatal.
  - Combined with a `{ halted, key }` move, this gives "a redline during drafting is applied once the draft has been handed to counsel".
- **Deadlines.**
  - `H.time.at(lane, data => Date)` arms a timer on the ledger. Any update to the unit re-arms it, recording `timer.superseded`.
  - `H.time.after(halt, d)` runs from the recorded `halt.opened`. It fires only if the halt is still open.
- **Resolvers.** Every resolution is recorded with its resolver, which is one of:
  - a human, through a client holding `H.ops.resolve(halt)`;
  - a policy, a `DecisionPolicy` placed at the halt site;
  - the clock, `H.ops.resolve(halt).with(fn)` on an `H.time.after` source.

### Metrics

- Every reading is `{ value, samples, window }`. Policies read metrics synchronously from a snapshot, and every read is recorded on `policy.decided`.
- **Dimensions** are typed columns or declared facets. A unit gets facet values in two ways:
  - from `flow.tag(facet, state => value)` during an attempt;
  - from `lane.create(child, event => facetValues)` at creation, so its first transition already carries them.
- **Success** comes from terminal verdicts. Attempt outcomes are for track records.
- **Step metrics.** `H.events.steps(exe)` streams the recorded `step.*` records of one executable.

### Memory

- **Recording.** A role records with `record(kind)`, a trigger with `journal.record`, and a command with `ctx.remember`.
- **Curation.** Kinds marked `.curated()` enter as candidates. `H.ops.memory.curate(kind)` exposes accept, merge and drop.
- **Recall** is a `Policy<'recall'>` over candidates, scored for specificity, track record and optional similarity.
- **Client reads.** `H.ops.memory.read(kind)` lets a client read a journal.

### Resumption

Resumption is replay over a memoizing ledger. The author writes none of it.

- **Addresses.** Every step has an address made of its step name, its loop name and iteration, and its parallel key.
- **Completed steps.** An address that already completed returns its recorded output at no cost.
- **The step running at the crash** is handled according to its kind:

  | Step | On restart |
  |---|---|
  | `repeatable` command | Rerun. |
  | `unrepeatable` command | Park with `interrupted`, unless `detect` finds the effect happened. |
  | `external` command | Ask `detect`. |
  | Seat | Ask the driver's `recover(session)`. |
  | Job | Collect by its recorded ref. A submit with no recorded ref asks `detect`, else parks. |

- **Definition changes.** A mismatch in the definition hash at or before the current address parks the attempt with `definitionChanged`. `H.ops.attempts.manage` can restart it from the top or abandon it.
- **Single writer.** `Ledger.acquire` grants a single-writer lease. A live holder makes `start()` refuse. A stale holder is taken over, and the takeover is recorded.

### Startup validation (`start()` fails)

`start()` fails on any of the following:

- two descriptors of one entity sort with one name;
- an exit label with no mapping;
- a trigger, spawn or event on an unregistered lane;
- a recall kind with no journal, or two journals of one kind;
- a seat model that no pool serves, or a multi-model seat with no policy;
- an account in a pool with other harness-shared accounts that names no quota partition;
- a facet repeating a column name, or a `by` column absent from the stream's records;
- an `external` command without `detect`;
- a job batch whose seat's accounts have no `BatchDriver`;
- a resource claimed by a flow but not covered by a resource-binding plugin of a role it runs;
- a halt referenced by a grant or timer that nothing places;
- an `order.failed` state that is not `waiting` or `terminal`;
- a `{ halted }` selector naming a halt that no flow of that lane places.

## What changed and why

Each change is listed against the seed brief.

1. **`H.agent` removed; the seat carries its skill.** One noun for role × skill × models (weakness 1).
2. **`flow.batch` removed; a model batch is `H.job(n).batch(seat)`.** GPU jobs and cloud batches share one resumption rule (weakness 2).
3. **Halt address versus halt entity.** `flow.halt(addressName, halt, contextMap, { resolver })` (weakness 3).
4. **`H.supervisor` and `H.scheduler()` removed.** A grant pairs a client with operations, and clients expose `transport`.
5. **`H.signal` removed.** External input arrives as supplier updates.
6. **Cancel, reopen, wake and re-entry unified as `lane.move(select, to)`.**
7. **Events are shared streams.** One vocabulary serves triggers, metrics and observers.
8. **Bounded re-entry lives in the exit map**, as `{ to, atMost, then }`.
9. **The lane's eight concerns, reduced.** Exits, retry and input mapping moved into `handle(flow, {...})`.
10. **Runners moved to `harness-dsl/runners`.**
11. **Supplier keying and mapping are adapter options.**
12. **Resource mapping is checked** (weakness 4).
13. **Attempt status `suspended` (job | children)** sits beside `blocked`.
14. **Decision policies return `D | undefined`.**
15. **Memory scope gains `facets`.**
16. **Branch removed.** `when` covers every branch in the battery.
17. **The ceiling maps its context.**
18. **`H.events.steps(exe)` added**, for scenario 3's owner-defined step metric.
19. **`H.ops.memory.read(kind)` added**, for scenario 4's journal that only a supervisor reads.
20. **`harness-dsl/rest` adapter added**, for the helpdesk and CMS of scenarios 2 and 6.
21. **Selectors see the event, and a halted selector is narrowed by key.** `Selector` changed in two ways.
    - `{ state, where }` now passes `(data, event)`. Scenario 9 cancels "the open Audit of the category that recovered", and the category is on the crossing event, not in a key the selector could rebuild. Audit keys carry the crossing time, so a later audit of the same category is a new unit.
    - `{ halted }` takes `key(event)`. Scenario 11 re-enters one redlined contract that waits at `counsel`. Before this change, `{ halted: counsel }` selected all forty.
22. **`lane.create(child, facets?)`.** Scenario 9 asks for "Audits opened per category this month". That is a count of transitions into the Audit's first state, by the category facet.
    - `flow.tag` records facets only once an attempt runs, which is after the creating transition. The creating trigger already knows the category.
    - With this change, the facet is recorded on the `unit.supplied` record itself.
23. **Scenario 7 makes no surface change.** Each harness derives its own `maxQuotaShare` from one shared account descriptor. The name is kept, which is legal because each harness registers exactly one derivation. The quota partition is named on the shared descriptor, so both harnesses fold the same append-only quota events.

## Principles broken

- **14 (bent, knowingly).** The envelope's `when` lists kinds, roles, skills, resources *and facets*. Scenario 9 requires an item scoped to a category. Making each category a resource would turn open-ended data values into declared entities.

Otherwise none.
