# harness-dsl: minimal, inferred (child of g02-minimal-0-2-2--2-2-1-0)

The operator is **inference**. I went through every scenario of the parent and collected each place that needed one of three crutches:

- a type annotation on a lambda parameter or return;
- an exported helper type (`SupplyOf<typeof k>`, `PendingView`, `Metrics`, `EntryFilter`, `Model`) used only to annotate;
- a hand-written guard against a type the surface had lost (`summaries[0] === undefined`).

For each one, the surface now changes so that the type flows from a schema or an entity the author already wrote. The scenarios contain no parameter annotations that exist only to satisfy the compiler.

This generation also repairs the adversary's three critiques: the pool × model pivot, seat credits, and moves on live units. It repairs the bonus point (`retries` meaning two things) and the scenario 10 notes.

## Inference repairs

| # | Where the parent needed a crutch | Cause | Change |
|---|---|---|---|
| 1 | `(unit): SupplyOf<typeof topic> =>` in schedules (s3, s8) and polls (s6). | A literal `state` inside a `.map` callback widens to `string`. Contextual return typing does not reach into `map`. | `H.schedule` and `http.poll` / `http.webhook` `read` now receive a second argument, `supply: Supplies<T, S>`, with `create(data, {key, state})` and `update(key, {patch, state, cancels})`. The method parameters are typed, so literals keep their type. `SupplyOf` is deleted. |
| 2 | `(item): FeatureData =>` in `ctx.spawn` (s1). | `T2` was inferred from both the lane and the data, and the two candidates conflicted. | `spawn(lane, data: readonly NoInfer<T2>[])`. The lane alone fixes the type. `Actions.create` and `Actions.run` get the same `NoInfer`. |
| 3 | `H.policy.rule('x', (input: z.infer<typeof about>, metrics: Metrics) => …)` (s2, s8, s9, s11, s12). | The rule had no source for `I`. | `H.policy.rule(name, inputSchema, (input, metrics) => O)`. This is the same pattern as role and command. `O extends Decided`, which includes primitives, so literal returns are kept without a return annotation. |
| 4 | `(about: …, metrics: Metrics): Decision \| null =>` for halt policies (s2, s11). | The halt policy was a free-standing rule. | `halt.policy(name, (about, metrics, self) => D \| null)`. `C` and `D` come from the halt. `self` is the halt, so the policy can filter on its own history without a circular reference to the constant being defined. |
| 5 | `const rank = (unit: PendingView) => …` and `breachAt` (s1, s2, s7). | The scheduler offered only a raw array. | `SchedulerView.sorted(key)`: an ascending, stable sort, with ties broken by `waitedMs` descending. |
| 6 | `text = (value: unknown, fallback: string)` (s7), and `z.string().parse(file.frontmatter['number'])` (s12). | Frontmatter was `Record<string, unknown>`. | `folder.files(kind, { frontmatter: schema, read })`. The frontmatter type `F` is inferred from the schema. |
| 7 | `summaries[0] === undefined` (s10). | `batch` returned `Result<O>[]`. | `batch` now returns a tuple mapped over its inputs. |
| 8 | `monthStart = (now: Date)` (s9), and a hand-computed `startOfDay` (s3). | No calendar windows. | `Window.period: 'today' \| 'thisMonth'`. |
| 9 | Typed reviewer-policy factories over a sibling seat (s6). | A policy could not see its sibling seat. | `ModelChoice.rivals`. |
| 10 | `type Sample`, `type Category` (s8, s9). | Rule inputs had no schema. | Covered by #3. |

`H.policy.model`'s `decide` returns `NoInfer<M>`, so `M` comes from the candidate list only.

## Repairs of the adversary's critiques

### Critique 1: the pool × model pivot

**Pools declare what they serve.**

- `H.pool(name, members, policy?)` returns a `PoolDraft`.
- Its one method, `.serves(...models)`, returns the `Pool`.
- `harness.pools()` accepts only a `Pool`.

**Models are vendor ids and prices, nothing else.**

- `Model` is a vendor id and a price; it carries no driver.
- The **account** carries the driver: `call`, `recover`, and optional `submit` / `collect`.
- The batch is a call mode on a capable account, priced from `Model.price.batchDiscount`.

**What an account policy sees.** `AccountChoice` carries `kind`, `seat`, `model` and `mode`.

**Startup and runtime checks.**

- A seat model, or a policy candidate, that no registered pool serves is a startup error.
- A batch on a model that no serving pool can batch fails the invocation with cause `kernel`. It is not counted against the model or the seat.

**Recovery.** Recovery reconnects through the account recorded on the invocation entry.

**Open for scenario 13.** The per-kind startup refusal is still open.

### Critique 2: seat identity smuggled through decision fields

**The declaration.** It is **`seat.judgedBy(halt)`**: the seat declares the halt whose resolver judges its work. (Run three moved this from `halt.credits(...seats)` to the seat; see below.)

**Resolving with credits.**

- `ControlApi.halts.resolve(attempt, decision, credited?)` names the credited seats.
- A seat not judged by that halt is rejected at call time.
- The kernel writes one `CreditEntry` per credited seat. Each entry carries:
  - the typed `seat` column;
  - the `model` that seat ran in this attempt;
  - its invocation `seq`.
- `HaltView.credits` lists the seats judged by the halt.

**Querying credits.** The scenario 6 metric is:

`rateBy({ among: editorial.resolved(), count: { entry: 'credit', halt: editorial, seat: choice.seat }, by: { modelOf: choice.seat } })`

**The rivals rule.**

- Each reviewer's model policy receives `choice.rivals`.
- The policy refuses a candidate equal to the rival's current model.

### Critique 3: moving a unit mid-attempt, and state versus position

**Rule 1a: a move from outside the flow cancels a live attempt first.** "Outside" means a trigger `act.move`, the control API `work.move`, or a matching supply update with `cancels`. It is one ledger transaction:

1. the attempt is cancelled;
2. its invocations end `cancelled`;
3. its leases are released;
4. the move is applied.

**Deferred supply updates.**

- A supply update that names a state but does not match `cancels` is deferred.
- An update naming a terminal state always cancels.

**State versus position.**

- **State** is the last recorded kind state. It answers "where in its lifecycle".
- **Position** is derived. It answers "what may the scheduler do".
- A state's declared position is its *rest* position.
- A live attempt overrides the rest position: `running` gives `active`; `blocked` or `suspended` gives `waiting`.

**Rule 1b: the `exhausted` state must be one of two things.**

- A terminal state.
- A waiting state on a lane that has an updating supplier.

A pending exhausted state is a startup error, because it loops.

### Bonus: one word, two policies (principle 22)

- **Retry** (`Lane.retries`) is a new attempt.
- **Reinvoke** (`Command.reinvokes`) is a new try of one invocation inside its attempt.

### The recovery probe

- A recovery executable is rerunnable by rule.
- A command with no `.recovery` defaults to `park`.
- Seats recover by asking the recorded account.
- A recovery probe that returns `true` means the step finished. The flow continues with no output.
- A probe that returns `false` parks the attempt on `H.halts.interrupted`.

## Entities

| Sort | Entity | Builder |
|---|---|---|
| Kind | state | `H.state(n, position[, verdict])` |
| Kind | kind | `H.kind(n).data(z).states(initial, ...)` |
| Kind | role | `H.role(n).input().output().prompt().intents()` |
| Kind | memory | `H.memory(n, sort)` |
| Kind | halt | `H.halt(n, decision).about().timeout().policy(name, fn)` |
| Kind | resource | `H.resource(n)` |
| Kind | facet | `H.facet(n, values)` |
| Instance | account, model, runner, store, memory store, supplier, ledger, quota partition, guard, observer, client | adapters only |
| Pivot | seat | `H.seat(n, role).model(m \| policy)`, then `.on .recalls .records .guards .judgedBy` |
| Pivot | lane | `H.lane(n, kind).handler(...).retries(n, {exhausted})`, then settings |
| Pivot | journal | `H.journal(n, memory, store, recall?)` |
| Pivot | pool | `H.pool(n, members, policy?).serves(...models)` |
| Pivot | trigger | `H.trigger(n, source, effect)` |
| Composite | flow, command, job, policy, operation, harness | unchanged |

## Execution vocabulary

| Term | Definition |
|---|---|
| Run | One process lifetime. |
| Attempt | One execution of a lane's flow for one unit. |
| Attempt state | `running`, `blocked` (on a halt), `suspended` (on a timer, children, a job, a batch or a lock), or `ended`. |
| Outcome | `succeeded`, `failed` or `cancelled`. |
| Invocation | One call of one executable. |
| Retry | A new attempt. |
| Reinvoke | A new try of one invocation. |
| Credit | A resolver's attribution of a halt decision to the work of a seat judged by that halt. |

## Rules carried from the parent

- The lifecycle skeleton and the four positions.
- Supply into live units: `cancels`, deferral otherwise.
- Facets derived from unit data.
- `Breakdown` keyed by entity.
- Preflight as a command.
- Memory, and recall policies that take similarity as an input.
- Atomic self-moves on `enters`.
- Key reuse decided by position.
- Hysteresis by `trip` / `reset` / `minSamples`.
- WIP and slots held only at position `active`.
- Locks scoped to an invocation or to an attempt.
- `sequence` with a parked exit.
- Jobs: submit, then collect, never resubmit.
- The cumulative unit ceiling.
- Quota partitions.
- Replay by `seq`.
- `definitionChanged` parking.
- `claimWriter`.
- Grants that name halts.

## Startup validation

`start()` fails, naming the offender, on any of the following:

- **Names and references:**
  - duplicate names;
  - a facet named like a column;
  - a trigger, spawn or create on an unregistered lane.
- **States:**
  - a flow, exhausted or sequence state outside the kind;
  - a parked or suspend state that is not waiting;
  - a pending exhausted state;
  - a waiting exhausted state with no updating supplier;
  - a deadline `whileIn` state outside the kind.
- **Seats and pools:**
  - a seat model or a policy candidate that no pool serves;
  - a seat `judgedBy` a halt that no registered operation can resolve, and no clock or policy can resolve either.
- **Recall and halts:**
  - a recall policy on a journal whose memory no seat recalls;
  - a halt `.timeout` or `.policy` that reads facts without `.about`.
- **Executables and the harness:**
  - a recovery executable that is not rerunnable;
  - a command with no runner that is not used as a preflight;
  - a missing ledger.

A harness with no pools, seats or models is valid.

## What changed and why

**Inference (the operator).**

- Added:
  - `Supplies` and the supply helper argument;
  - the schema argument of `H.policy.rule`;
  - `halt.policy(name, fn)`;
  - `SchedulerView.sorted`;
  - the folder `frontmatter` schema;
  - tuple-typed `ctx.batch`;
  - `Window.period`;
  - `ModelChoice.rivals`;
  - `NoInfer` on `spawn` / `create` / `run` / model policy returns.
- Removed: `SupplyOf`, and the rule used as a halt policy.

**Critique 1.**

- Added: `PoolDraft.serves`. Accounts now drive models. `AccountChoice` gained kind, seat, model and mode.
- Removed: `Model.provider`, `Account.provider`, the model driver methods, and `claudeCode.model`.

**Critique 2.**

- Added: `CreditEntry`, `resolve(…, credited)` and `HaltView.credits`.
- Decision fields no longer encode seats.

**Critique 3.** Rules 1a and 1b, state as rest position, and `Supplier.updates`.

**Bonus.**

- `Command.reinvokes`.
- `park` is the default recovery.
- Recovery probes must be rerunnable.

### Run three: writing scenarios 1 to 6 against this surface

Three gaps showed up, and each is closed with the smallest change.

1. **`halt.credits(...seats)` moved to `seat.judgedBy(halt)`.**
   - *The gap.* In scenario 6, each reviewer's model policy reads the editorial halt's credit series. The seats need those policies. So the halt needed the seats, and the seats needed the halt. TypeScript reports this as a circular initializer, and no ordering of the declarations breaks it.
   - *The fix.* The relationship moves to the seat, which is a pivot, so principle 10 holds. The order is now: halt, then policy (reading the halt), then seat (judged by the halt).
   - *The effect.* `HaltView.credits` is derived from the registered seats.
2. **`halt.policy` passes `self`.**
   - *The gap.* Scenario 2's safe-category policy must count its own halt's past human resolutions. Referencing the constant inside its own initializer is circular.
   - *The fix.* The policy now receives `self: Halt<D, C>` as a third argument.
3. **`H.on.deadline(kind, due, whileIn, blockedOn?)`.**
   - *The gap.* Scenario 5 cancels a unit "left waiting for approval" at 09:00. By principle 12, waiting on a human is the attempt's blocked state, recorded once, not a kind state. A deadline that can only name kind states would force the author to invent an `awaiting-approval` state, which models the wait twice.
   - *The fix.* The optional `blockedOn` halt narrows the deadline to units whose live attempt is blocked on that halt.

The net surface change is one method moved, one parameter added and one optional argument added.

Scenario 2 keeps its seven named lifecycle states because the brief names them. Its in-flow states (`classifying`, `drafting`, `awaiting-approval`) rest at `pending`, so a cancelled or retried attempt leaves a schedulable unit.

### Run four: writing scenarios 7 to 12 against this surface

One gap, one optional argument.

1. **`Lane.sequence(order, parked, within?)`.**
   - *The gap.* Scenario 12 requires two things at once:
     - migrations on one database run in order (0042 after 0041 has succeeded), and a failed predecessor parks its successors;
     - migrations on different databases run concurrently.
     A single lane-wide order serializes every migration in the lane. Splitting into one lane per database would make the supplier topology mirror the resource map, which the brief does not ask for.
   - *The fix.* `within` names the group a unit is ordered within. A unit waits only for its predecessor inside its group, and a failure parks only that group's successors. Omitted, the lane is one group, as before.
   - *The effect.* The resource lock still prevents overlap. The sequence now only orders.

Recorded patterns from writing scenarios 7 to 12 (no surface change):

- **Monthly re-evaluation (s8).** It is a daily `H.schedule` that updates units whose recorded review month differs from the current one. That keeps "one review per calendar month" in unit data without a monthly `TimeSpec`.
- **Long-observation units (s8).** An Experiment that samples hourly is one attempt that suspends on a waiting state between samples. It holds no capacity. Completed samples replay by `seq`.
- **Bounded returns (s11).** These use `H.on.enters(kind, 'returned', { times: 2 })` with a self-move. The flow counts nothing.
- **A redline while waiting on counsel (s11).** It is a supply update with `cancels: ['waiting']`, which re-enters at `draft` in a new attempt. A redline while drafting does not match `cancels`, so it is deferred.
- **Shared quota (s7).** It is one `sqlite.quota` partition given to the same three account descriptors in both harnesses. Each harness has its own ledger and its own pool shares.

### Weaknesses left open

- The address of a halt within a flow.
- Batch and job are still two step forms.
- The per-kind refusal for scenario 13.
- The lane carries many concerns.
- A command cannot record memory itself. Scenario 6's fact-check returns its findings, and the flow records them.
- One supervisor session across two harnesses (s7) is two plain HTTP control endpoints. The session itself has no entity.
- Scenario 7's Harness A is written as Bugs and Features only (no Epic, no heartbeat, no auditor-driven memory beyond experience). That is enough to show what the two harnesses share, but it is not all of scenario 1.

## Principles broken

None.

The parent's claim of "none" was wrong for principles 9 and 22. Both are repaired above.
