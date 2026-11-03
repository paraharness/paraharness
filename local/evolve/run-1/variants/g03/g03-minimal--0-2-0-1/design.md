# harness-dsl: quota partition, honest attempts, recorded reads (child of g02-minimal-al-0-2-0)

The operator is **scenario-fix**. The worst-handled scenario was **07 (two projects, shared subscriptions)**. The parent's version had four problems:

- It wrote a reduced coding harness rather than scenario 1.
- It had no shared module.
- Its shared quota was an untyped path string that each harness repeated.
- It left the API fallback orphaned outside any pool.

This child gives shared account state an owning entity. It also repairs the adversary's three sharpest critiques: replay determinism, attempt outcomes that lie, and memory scope written as strings.

## Entities

| Sort | Entity | Builder | Produces / is |
|---|---|---|---|
| Kind | **state** | `H.state(name, position)` or `H.state(name, 'terminal', verdict)` | A named, shareable lifecycle position. |
| Kind | **kind** | `H.kind(n).data(z).states(initial, ...others).failsTo(first, ...others?)` | A data shape, its states, and its declared failure moves. |
| Kind | **role** | `H.role(n).input(z).output(z).prompt(f).intents([...])` | What a model call is asked to do. |
| Kind | **memory** | `H.memory(n, 'experience' \| 'taste')` | A memory kind. |
| Kind | **halt** | `H.halt(n, decisionSchema)` | A named outside decision with a typed answer. |
| Kind | **tag** | `H.tag(n)` | A named dimension, such as category, section, model, database or area. |
| Instance | **account** | `cc.subscription(n, { token, quota? })`, `anthropic.account(n, { apiKey, quota? })` | A credential, plus where its quota events live. |
| Instance | **quota ledger** | `sqlite.quota(name, path)` | The quota partition of the ledger: append-only usage, cooldown and cap events. |
| Instance | model, runner, store, memory store, supplier, ledger, guard, observer, client | adapters | Specific resources. |
| Pivot | **agent** | `H.agent(n, role).model(m \| policy)` | role × model. |
| Pivot | **lane** | `H.lane(n, kind).handler(flow, params?)...` | kind × suppliers × store × handler. |
| Pivot | **archive** | `H.archive(n, memory, store)` | memory kind × store: where items live. |
| Pivot | **briefing** | `H.briefing(n, archives, ranking?)` | archives × recall policy: what a call is told. |
| Pivot | **pool** | `H.pool(n, members, policy?)` | accounts × shares × policy, for one harness. |
| Pivot | **trigger** | `H.trigger(n, source, effect)` | A recorded consequence of recorded state. |
| Composite | flow, command, policy, operation | as in the parent | |
| Root | **harness** | `H.harness(n)...start()` | |
| Adapter value | **supervisor session** | `cc.session(n, { endpoints })` | One Claude Code session that can address several control endpoints. |

## Execution vocabulary

- **Run**: one lifetime of a harness process.
- **Attempt**: one execution of one flow phase for one unit.
  - Its states are `running`, `blocked` and `ended`.
  - When ended, its outcome is `succeeded`, `failed` or `cancelled`.
- **Invocation**: one call of an executable.
- **Recorded call**: any other sequenced `ctx` call. These are `now`, `tag`, `decide`, `children`, `move`, `update`, `remember` and `spawn`. Each is a `recorded` ledger entry.
- **Phase**: the flow body selected by the unit's state at attempt start.

"Step" is not a word in this design.

## Rules

### 1. Skeleton and honest attempt outcomes (principle 12; critique 2)

| The phase returns | Attempt outcome | What happens to the unit |
|---|---|---|
| A state | `succeeded` | Moves to that state. |
| `ctx.wait(state, wake)` | `succeeded` | Parks in a waiting state. |
| `ctx.fail(reason)`, or it throws | `failed` | Stays at its pending state under the lane's retry policy. The default is backoff: 1 minute, doubling, capped at 1 hour. |
| `ctx.fail(reason, to)` | `failed` | Moves to `to`. |
| Interrupted by a move, preemption or cost ceiling | `cancelled` | Handled by the rule that interrupted it. |

**Declared failure moves.**

- `ctx.fail(reason, to)` is allowed only when `to` is among the states the kind declares in `.failsTo(...)`. This is principle 12 as written: a kind declares the move, and only then does a failure move the unit.
- An undeclared `to` is a kernel error. The attempt still fails and the unit does not move.
- A retry policy's `'stop'` moves the unit to the first `failsTo` state.
- `start()` refuses a lane that has `.retry()` when its kind declares no `failsTo`.

**Measurements and reviews do succeed.**

- An hourly Experiment measurement that recorded its sample is an attempt that did what it set out to do. The same holds for a Tenancy review that produced a decision.
- The unit's own outcome is a separate fact: its terminal verdict. Principle 18 forbids conflating the two, and they are not conflated.

### 2. Replay is deterministic by construction (critique 1)

Every `ctx` method that reads from outside the body or writes harness state is sequenced on the ledger. On restart, the phase body re-executes and each sequenced call returns its recorded value.

**Divergence check.**

- Before a sequenced call is accepted, the kernel compares it with the recorded entry at that `seq`: same call type, same executable or halt, same input hash.
- On a mismatch the kernel raises the kernel halt `definition-changed`, with reason `diverged at seq n`. The supervisor resolves it with `restart` or `abandon`.

### 3. Memory scope by reference (critique 3)

- `MemoryDraft.when` is `{ kinds?, roles?, tags? }`, filled with entity references and `TagMatch`.
- Resources and skills are tag dimensions.
- `MemoryItem.when` is stored as a `ScopeRecord` of names.

### 4. Shared account quota (scenario 7; principle 15)

**Where quota lives.**

- Quota is a ledger partition: a `QuotaLedger` of append-only `usage`, `cooldown` and `cap` events, folded at read time.
- Every `Ledger` has a default partition, `ledger.quota`. An account may carry its own partition instead.
- A harness appends its consumption to the account's partition and folds from it. Its single-writer lease never touches the partition.

**Registration.** At start, each harness calls `partition.register(harnessName, ledgerName)` and appends a `cap` event for each pool member's share.

**What each supervisor sees.** `AccountView.byHarness` shows every harness's cap and usage.

### 4a. Keys, grouped firings and deadlines (stated in generation 3)

These rules were implicit in the parent. The scenarios depend on them, so they are now written down.

**Unit keys.**

- A unit has a kernel id and an optional key.
- `create(lane, data, key)` with a key that names a non-terminal unit in that lane is a no-op, and is recorded as such on the firing.
- A key whose unit is terminal names a new unit. The old unit keeps its id and its history.
- `move(lane, key, state)` targets the non-terminal unit with that key, and is a no-op when there is none.
- Supplies with `create` follow the same rule. A webhook and a poll that both deliver one conversation therefore produce one unit.

**Grouped firings.**

- A metric source grouped by a tag records its firing with `tags[group.name] = group`.
- Units that the firing's effects create inherit that tag from their first transition onward.
- As a result, "audits opened per category" is a `countBy` over transitions, with no extra bookkeeping.

**Deadlines.**

- A `deadline` source re-reads `due(data)` after every recorded change to the unit's data. This covers flow `update`, supply `patch` and the control API's `work.update`.
- Re-reading disarms the old timer, so a deadline that was moved never fires at its old time.
- Arming and re-arming are `recorded` entries, so the timer is ledger state.

### 5. Recall, supply, triggers, scheduler, cost, durability, control, validation

These are as in the parent, with the changes above. Startup validation additionally refuses:

- a `failsTo` state that is not one of the kind's states;
- a quota partition registered by a different ledger under the same harness name.

## What changed and why

**Generation 2 (versus the parent).**

- Scenario 7: added `QuotaLedger`, `sqlite.quota`, `Account.quota`, `QuotaEvent` with `cap`, `AccountView.byHarness`, `Endpoint`, `http.control().endpoint` and `cc.session`.
- Critique 1: `ctx.now()` and `ctx.tag()` became async recorded calls, and the divergence check was added.
- Critique 2: added `failsTo` and `ctx.fail(reason, to)`.
- Critique 3: `Scope` now takes entity references and `TagMatch`. `ctx.children` is typed, and `Metrics.sum` returns `Total`.

**Generation 3 (writing scenarios 06 to 10 against this surface).**

- **Added `Metrics.countBy({ among, by, ...window })`.**
  - Scenario 9 asks for "how many Audits were opened per category this month". `rateBy` could only answer it by passing one filter twice and reading `samples`, which is a counting question disguised as a rate.
  - `countBy` returns `Total` per tag value. It is the one new method, and scenario 9 calls it.
- **Stated §4a.** These are not new surface. Scenarios 6, 8, 9 and 10 depend on three semantics the parent left implicit:
  - Scenario 9's Audit deduplication and the webhook-plus-poll supply in scenarios 2 and 9 depend on key reuse.
  - Scenario 9's per-category audit count depends on the grouped-firing tag.
  - Scenario 9's SLA extension through the supervisor depends on deadline re-arming. The old deadline never fires.
- **Scenario 7** is written as one exported `shared` object and two functions, `codingTeam(shared)` and `documentation(shared)`. The coding harness is all of scenario 1. The owner's session addresses both `http.control` endpoints.
- **Scenario 8 keeps the skeleton.**
  - Experiment: `aWins` and `bWins` are success, `inconclusive` is neutral.
  - Tenancy: waits between monthly reviews in a waiting state, is suspended into another waiting state, and churns into a neutral terminal state.
  - Negotiation: each round is one attempt that ends in `ctx.wait`. The vendor webhook supplies `update` and never creates a unit. Expiry is a deadline trigger.
  - Success rate therefore keeps its meaning: success over success plus failure verdicts, with neutral counted beside them.

## Principles broken

None.

- **Principle 14.** The envelope's skills and resources are carried as typed tag matches. Every dimension the principle names is still in `when`.
- **Principle 15.** Shared quota is an append-only partition of the ledger, carried by the account instance. It takes no lock and does not share the ledger's name.
