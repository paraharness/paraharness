# Generation 1 front

- g01-durable-0-2-0-1--2-0-1-2 (durable-0-2-0-1, lens, pareto): bt 1.5579, compile errors 0, escapes 0, any-in-dts 0, surface 350, coverage 12/12, cannot: none, strikes: none
- g01-minimal-0-2-2--0-2-2-2 (minimal-0-2-2, rename, pareto): bt 0.9057, compile errors 0, escapes 0, any-in-dts 0, surface 229, coverage 12/12, cannot: none, strikes: none
- g01-minimal-0-2-2--0-2-2-1 (minimal-0-2-2, scenario-fix, pareto): bt 0.3553, compile errors 0, escapes 0, any-in-dts 0, surface 222, coverage 12/12, cannot: none, strikes: none
- g01-durable-0-2-0-1--2-0-1-0 (durable-0-2-0-1, delete, by rank): bt 0.0401, compile errors 0, escapes 0, any-in-dts 0, surface 359, coverage 12/12, cannot: none, strikes: none

## Critiques

### g01-durable-0-2-0-1--2-0-1-2

## 1. Worst-handled scenario: 1, coding team (the founding scenario)

The build-and-audit loop is the core of the scenario, and the variant cannot feed the auditor's deficits back to the builder.

- **The builder never sees the deficits.** The builder's `task` in round N reads only `ctx.unit.attributes` and `ctx.iteration`. Yet `builderRole.instructions('…Address every deficit the auditor listed in earlier rounds.')` promises otherwise. The prompt says one thing and the types forbid it.
- **The design admits it.** Under Open it says: "In scenario 1, the builder learns the auditor's deficits from the attempt's session and memory." In practice that means the vendor session state or journal writes. Hidden state in a driver session breaks principle 1, and recording round-local deficits as memory breaks principle 14 (memory is forward-phrased, not history).
- **The loop runs on steps it cannot pass forward.** `until: ctx => ctx.steps.audit.deficits.length === 0` reads the audit output, but the next `build` cannot.
- **Smaller wounds in the same file:**
  - "Heartbeats first" is written as `.standard(heartbeatLane, …)` here but `.expedite(heartbeats)` in scenario 7, so the battery has two encodings of one requirement.
  - `.share(subscriptionC, 0.3)` beside two shares of 0.5 is never explained.
  - Bugs filed by the heartbeat trigger go through `create` into the Linear store. That works, but nothing types or checks it.

## 2. New scenario: Grant application, bounded returns across re-entry

- **Kind and flow.** Kind `Application`, supplied by webhook. Flow: `assess` (agent), halt `panel`, `notify` (command, wrong to repeat).
- **Returns.** The panel may return the application with notes, at most twice over the unit's whole life. The third return ends in `Rejected`, a failure.
- **Applicant revisions.** The applicant may submit a revision at any time. A revision during `panel` re-enters at `assess`, and that re-entry does **not** reset the return count.
- **Prompt content.** Each `assess` prompt must contain every prior panel note, verbatim.
- **No ledger reads.** The flow reads nothing from the ledger, and no notes are stored in memory.

**Why this variant cannot express it:**
- **The bound resets.** The bound lives in `loop(…, { max: 2 })`, which is per attempt. `on(revision, { restart: 'assess', at: ['panel'] })` cancels the attempt and pulls a new one, so the count starts again. Scenario 11 ships this exact hole.
- **The notes have no path.** `Reaction.update` sees only the signal payload, and no reaction exists for "decision recorded". Notes can reach attributes only through a trigger that `signal`s the unit back to itself, or through `unit.failedAttempts`-style arithmetic. Both are escape hatches.

## 3. Sharpest critiques

1. **Strings stand in for entities, against principle 8.**
   - `event.unit.state === 'AwaitingCustomer'` (s02 trigger).
   - `stored.state === 'Customer'` (s08 scan).
   - `assignment.seat.name === drafter.name` (s02).
   - `sectionsOf(section: string)` and `resourcesFor(name: string)`, which look resources up by name (s06, s09).
   - `PatternEvent.group: string` and `CrossingEvent.value?: string`, which leave the facet value untyped. Scenario 9 must guard `event.value === undefined` on every consequence.
   
   States are entities, yet `UnitView.state` is `SN` (a name), so every comparison is a string. Facets were made entities, and their values came back as free strings.

2. **Timer re-arm is a hidden coupling.**
   - `H.when.timer` "re-arms it after every `attributesUpdated`". Any reaction `update` therefore re-arms every timer on that lane, including timers whose deadline does not depend on the changed field.
   - The scenario 11 redline `update` would re-arm an expiry timer. The scenario 2 `customerReplied` update re-arms the SLA timer.
   - Scenario 9's SLA extension works only by accident of this rule, and nothing declares which attribute a timer depends on.

3. **The seat is an overloaded pivot, and batch-ness leaks onto it.**
   - **Too many concerns.** `Seat` carries role, model or policy, pool, workspace, guard, raisable halts, output schema and `.batch()`. Weakness 6's "eight concerns" complaint has moved from the lane to the seat.
   - **Batch is a property of the executable.** `seat.batch()` returns a `Job`, so batching belongs to the executable, not to the step. Scenario 10's `summarizerSeat` pairs an `anthropic.model` with a pool containing a `claudeCode.subscription`, and only startup rule 9 catches the mismatch. This is weakness 5 unresolved; the design admits as much.
   - **The A/B can collapse in scenario 6.** `reviewerModel(…, challenger, …)` can swap both seats to `challenger`. Once swapped, `mine` still measures the old `incumbent` series, so the policy never swaps back. Two seats then end up on one model, against "two agents of the same role on different models".
   - **Rival seats need a thunk.** The rival seat is reached through `(): SeatRef => reviewerB`, a forward-reference workaround the surface forces on the author.

Also of note:
- **Economy.** `admit` lambdas re-implement scheduling rules, such as `ended.byState.Inconclusive / ended.terminal` in s08 and the `paused` gate in s09, that no scenario asked for.
- **Scenario 12.** "GPU hours in flight per day" is computed at step end from `durationMs`. A job running at midnight is counted on the wrong day, and jobs still in flight are invisible.

### g01-minimal-0-2-2--0-2-2-2

## (1) Worst handled: Scenario 9, a harness watching itself

- **SLA extension is missing.** No line in `09-self-watch.ts` lets the reviewer extend a deadline.
  - The timer is `H.on.deadline(conversation, data => new Date(data.slaDueAt), ['new','sent'])`. It reads a field of unit data, and that data lives in `http.store`, the helpdesk.
  - The design never says that an update re-arms the deadline.
  - It never says that the old deadline is withdrawn.
  - The requirement "the old deadline never fires" is therefore unspecified, not expressed.
- **Human rejection is recorded as a failure.**
  - `if (!decision.approved) return ctx.fail('reviewer rejected the draft')` turns a human rejection into an attempt failure.
  - `.retry(H.policy.retry('redraft-twice', …), 'escalated')` then retries it and ends the unit at `escalated`, which is `neutral`.
  - The drafter's track record is charged with failures that are human decisions.
  - Repeated failure is laundered into a neutral verdict. That is a lie on both counts.
- **"A policy elsewhere" is answered inside a flow.**
  - `auditHistory` is reached only through `ctx.decide` inside the Audit flow, and its result is pasted into halt text.
  - Scenarios 11 (`decisionReport` in the `signoff` show string) and 12 (`platformLoad`) repeat the trick.
  - Required metrics are stuffed into prompts because there is no telemetry projection entity.
- **Approval rate by model is dropped.** Scenario 2's "approval rate by model" requirement is absent from 09's drafter: `.model(sonnet)` is fixed.

## (2) New scenario 13: deploy windows

A platform team ships to production.

### Must express

- Kind `Deploy`, supplied by the operator. Its flow:
  1. halt `go-no-go`;
  2. `apply` (a command);
  3. `canary` (an external job, 6 h);
  4. halt `go-no-go` again;
  5. `promote` (a command).
- **Step-scoped lock.** `apply` and `promote` each hold an exclusive lock on resource `prod`. The lock is released while `canary` runs, so other deploys may apply in between.
- **Counted resource.** Resource `gpu-quota` admits at most 3 concurrent holders across the kinds `Canary` and `EvalRun`. It is not a runner and not a host.
- **Halt by address.** Metrics show median decision time for the first and the second `go-no-go` separately, with sample counts.

### Why this variant fails it

- `lane.locks(data => Lock[])` is attempt-scoped. The design admits step-scoped locks are left out.
- `LockMode` is `'exclusive' | 'shared'`, with no count.
- The halt address is explicitly left open (`seq` only), so the two `go-no-go` raises cannot be told apart in metrics.

## (3) Sharpest critiques

1. **Capability strings survive, breaking principle 17.**
   - `H.ops.resolveHalts` is a blanket grant naming no halt. It is used in scenarios 1, 7, 8, 10 and 12.
   - It is the same concept as `H.ops.resolve(...halts)` under two words (principle 22).
   - The control API is string-typed throughout: `halts.resolve(halt: string)`, `work.create(lane: string)`, `memory.list(journal: string)`, `work.move(key, state: string)`.
   - The kernel boasts "descriptors, not strings" in `EntryFilter`, then abandons the rule at the client boundary (principle 8). `EntryFilter.status?: string` and `state?: string` are untyped as well.
2. **`RetryView.failures` means two things.**
   - One policy type counts attempts on a lane and invocations on a command (`counting: 'attempts' | 'invocations'`).
   - The battery shows the ambiguity biting:
     - Scenario 5's `view.failures > 3 ? 'stop'` and scenario 11's `view.failures < attempts` use opposite boundary conventions.
     - Scenario 12 adds a third, `failures < 3`.
   - Nobody can tell whether "3 retries" means 3 or 4 tries.
   - Known weakness 2 is also untouched:
     - Batch lives on `ctx.batch(seat)` plus `Model.submit/collect`.
     - External jobs live on `H.job(...).submit().collect()`.
     - These are two submit-and-collect step kinds.
3. **Hidden coupling of a halt to seats, plus an overloaded lane.**
   - In scenario 6, `editorReview`'s decision schema hard-codes `actedOnA` and `actedOnB`. The `uptakeChoice` policy keys on those literal field names. The halt entity therefore knows which seats exist, which breaks principle 10 in spirit.
   - Renaming a seat or adding a third reviewer breaks the halt and the series. That defeats the stated purpose of "seat keys survive a swap".
   - The lane now carries ten concerns:
     - kind
     - handler
     - suppliers
     - store
     - `wip`
     - `maxUsdPerUnit`
     - `retry`
     - `locks`
     - `order`
     - pause state
   - That makes known weakness 6 worse.
   - `.order(...)` adds a back door: `writeWork`'s `work.move` lets any supervisor bypass ordering silently.

### g01-minimal-0-2-2--0-2-2-1

## 1. Worst scenario: 11, halts with a clock

The file compiles. It also misstates three requirements.

**A redline during `counsel` does not re-enter at `draft`.** `readContractEvent` always returns `{ update, patch, state: 'received', deferred: true }`. Deferred means the update applies after the attempt ends. A unit parked on `counsel` for days therefore keeps its stale draft until counsel rules on text that is already obsolete. The scenario asks for two different behaviours: defer while `draft` runs, re-enter while waiting on counsel. The `Supply` shape has no way to say "re-enter if waiting, defer if active".

**The deputy cannot resolve.** `pageDeputyAtTwentyMinutes` runs a `pageDeputy` command. The only grant on `signoff` is `claude.supervisor({ grants: [H.ops.resolve(signoff)] })`. "Either person may resolve" needs a second resolver with its own client, and none is declared. The page is a notification with nothing behind it.

**The return bound races the retry loop.** `'returned'` is a *pending* state, so `return 'returned'` is a succeeded attempt that re-queues the unit at once. `declineAfterSecondReturn` then moves it to `declined` through a trigger. That move cancels whatever attempt the scheduler has already started on the second return, and a cancelled attempt lands in the drafter's track record. The bound the scenario asks for, "declared and kernel-enforced", is really a trigger racing the scheduler.

Scenario 9 is a close second:
- `auditsOpened` filters `firing` entries by `facets: [category.of(value)]`. Facets are stamped only by `ctx.facet` inside attempts, and a trigger firing has no attempt, so the count is always 0.
- `act.create(audits, …, 'audit-${group}')` reuses a key after `withdrawn`. Whether re-creating over a terminal unit dedupes or fails is unspecified.

## 2. New scenario: two keys, one question

> **Scenario 13: dual-control payouts.** Kind Payout, supplied by webhook. Flow: `prepare` (command), halt `approve` asked of the finance lead, `screen` (command), the *same* halt `approve` asked again of the compliance officer, `pay` (wrong to repeat).
>
> - Each gate has its own grant. Finance resolves only the first gate over HTTP; compliance resolves only the second through the supervisor.
> - Each gate has its own 15-minute clock default: the first gate's default is approve, the second gate's default is reject.
> - Metrics report median decision time per gate with sample counts.
> - A policy skips the *second* gate only, after 300 clean samples.
> - Renaming `screen` must not move one gate's series onto the other.

This variant cannot express it honestly:
- `H.ops.resolve(approve)` grants both gates.
- `.timeout` and `.policy` live on the halt entity, so both gates share one default and one skip.
- `decisionMs` keys on `halt` only. The design notes concede that the gates are "distinguishable only by sequence number", and sequence numbers shift when a command is inserted.

The workaround is two halt entities, `approveFinance` and `approveCompliance`, with an identical schema. That is a duplicated entity standing in for a missing address, and it is exactly known weakness 3, left unpaid.

## 3. Sharpest critiques

1. **The kernel retry default breaks principle 12 and scenario 11.**
   - "A lane without `.retries` uses the kernel default: unbounded retries … never exhausts."
   - Principle 12 says the lane's policy names where exhaustion leaves the unit. Scenario 11 calls a missing end a startup error, not an infinite loop.
   - Scenario 8 relies on this silently: `experiments`, `tenancies` and `negotiations` declare no `.retries`, so a failing `analyseExperiment` loops forever.
   - The variant claims "principle 12 now holds without exception", which is false.

2. **"Waiting" means four things (principle 22).**
   - It is a position (`'waiting'`).
   - It is an attempt status (`'waiting'`, beside a distinct `'blocked'`).
   - It is a state position (`H.state('observing', 'waiting')`).
   - It is a flow verb (`ctx.wait`).
   - On top of that, `LiveView.position: 'active' | 'waiting'` and `Supply.deferred` describe the same "not now" idea a fifth way.
   - A reader cannot tell whether `ctx.wait('awaiting-features', …)` sets the unit's state, the attempt's status, or both.

3. **Facets and model keys are strings and side effects (principles 8 and 18).**
   - **Facets are imperative and attempt-bound.** A metric dimension exists only if a flow remembers to call `ctx.facet(category, v)` before the entries it should tag. This hides a coupling between flow code and every policy that reads `rateBy({ by: category })`. Trigger firings, supply transitions and pre-`facet` invocations are invisible to that dimension (scenario 9, above).
   - **Model keys are strings.** `{ modelOf: seat }` returns `Record<string, Rate>`, read as `byModel[sonnet.name]`, so a string stands in for the model entity.
   - **Adapters fall back to raw strings.** In the same vein, `http.store({ stateField: 'harness_state' })`, `qdrant.memory({ embedder: 'text-embedding-3-small' })` and `ssh.host({ preflight: ['test "$(df …'] })` push shell and vendor strings where an entity or a command (`H.command`) already exists.
   - **The disk preflight cannot be a command.** It is a string, so it has no recovery, no ledger row and no metric.

### g01-durable-0-2-0-1--2-0-1-0

## 1. Worst scenario: 8, lifecycles that do not fit

The Tenancy and Negotiation lanes only work by mapping things onto states that do not mean them.

**Tenancy hides its failures.**
- `.retry({ maxAttempts: 3, ..., exhausted: Customer })` sends a tenancy whose review failed three times back to `Customer`, a healthy waiting state. Exhaustion produces no failure fact, and no board or metric can tell "reviewed, hold" from "review crashed thrice."
- `exits: { upsell: Customer, hold: Customer }` collapses the human's upsell decision into one state. "How often do we upsell" is answerable only by a hand-written decision metric.
- `to.signal(monthlyReview, unit => unit.state === 'Customer', {})` compares against a raw state string. The `Customer` entity exists; the router cannot take it.

**Negotiation moves state under a running attempt.**
- `.on(vendorCountered, { enter: Countering })` targets a *pending* state. Rule 2 cancels an attempt only for an `enter` into a terminal state.
- So a counter arriving while `draft` runs moves the unit to pending with an attempt still active. That is a position lie: the unit is schedulable while it holds a slot.
- `exhausted: Stalled` is a waiting state with no reaction that leaves it except vendor signals. An exhausted negotiation dead-ends silently.

**Runner-up: scenario 1's placeholder lane.**
- `.spawn('features', H.lane('features-placeholder', Feature), () => [])` and `void decomposeEpic` ship an unregistered lane and a dead flow.
- This is an escape hatch the startup validation ("trigger, metric… references a lane the harness does not register") does not even cover for `spawn`.

## 2. New scenario: reopened work

> **Scenario 13: work that comes back**
>
> A Bug the harness marked Done is reopened in the tracker three days later (regression). It is the *same* bug: same key, same history, same Linear issue.
>
> **Must express:**
> - The reopened unit leaves its terminal state and returns to pending under its original id.
> - The kind's success rate counts the first Done as revoked, not as one success plus one new unit.
> - A policy can ask "how many units of Bug were reopened within 7 days of Done, per seat that built them, with sample counts".
> - Memory items present in the revoked attempt lose track record.
>
> **Hostile aspects:**
> - A terminal state that is not final.
> - Identity spanning a terminal.
> - Retroactive verdict.

This variant cannot express it:
- `Kind.key` dedups only among *non-terminal* units (`createSkipped`).
- `to.signal(...)` to a terminal unit records `signalSkipped`.
- The only path is `to.create(...)`, which makes a second unit with the same key. Outcome metrics then report two units and one success instead of one regression.

## 3. Sharpest critiques

**1. `Lane` is the overloaded pivot, and it grew.**
- Principle 8 defines lane as kind × suppliers × store × handler.
- This lane also carries `retry`, `lease`, `after`, `on`, and `ceiling`.
- `after({ key: a => a.previous })` makes ordering between units a lambda returning a **string key**: a string standing in for a unit, unchecked at startup.
- Scenario 12 derives `previous` by `Number(id) - 1` across *all* databases. So 0042 on `users` waits on 0041 on `orders`. That is incidental coupling the DSL cannot catch.
- `HeldByOrder` has no release path if 0041 is later recovered.

**2. A model policy that branches on seat identity by string, with a forward reference.**
- Scenario 6: `const isA = seat.name === reviewerA.name; ... rival = isA ? reviewerB : reviewerA` sits inside `reviewerModels`, declared before `reviewerA` exists.
- The seat, the "earned" A/B key, is useless here: one policy hard-codes both seats, their incumbents (`isA ? opus : sonnet`), and the challenger.
- The A/B comparison is neither a pivot nor shareable. A third reviewer means rewriting the policy.

**3. "Exit" means two things, and blocking forms have two words.**
- `exits` maps to terminal states (`Done`) and to non-terminal ones (`AwaitingVendor`, `Customer`). "Exit" therefore means both "the unit is done" and "this attempt ended, the unit sleeps."
- Rule 2 then calls both "success", so the attempt track record cannot separate "negotiation offered" from "agreed."
- `step(seat.batch())` and `job(...)` are two spellings of submit-and-collect. The design admits this ("Open").
- `askIf` versus `skip` are two halt-bypass mechanisms with different ledger events (`haltSkipped` versus `decisionRecorded`).
- In scenario 11, "a deputy is paged and either person may resolve" has no entity: `escalate.run` pages a command, but only `finance-supervisor` holds `resolve(signoff)`. The deputy can be woken and never act.
- Kernel `UnitView.kind: string` and `MemoryItem.when.kinds: readonly string[]` reintroduce strings for entities principle 8 says are referenced by identity.
