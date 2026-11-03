# Known weaknesses of the seed design (as of 2026-11-01)

These are the gaps I can see without the loop. They are fed to the adversary as "known; find what we did not see", and to mutation as targets.

1. **Flows are coupled to state entities.** `ticketFlow` names `Working`, `Done`, `Abandoned`, so any kind handled by it must own those states. Shared state entities soften this; they do not remove it. Alternative not explored: flows transition to skeleton outcomes and the lane maps them to the kind's states.
2. **`spawn` with `await: true` holds a slot** while children run. The better engine behaviour is that the attempt ends at the spawn and the kind's flow re-enters when children terminate, so an Epic has several attempts. Not designed.
3. **Roles name Claude Code tools** (`.tools(['Read', 'Edit'])`). A role is vocabulary; tool names are a driver's. Should be intents the driver maps.
4. **`.resources()` is path-shaped.** Resources might be entities (`H.resource`) so leases and memory scope can name services, databases, environments, not only globs.
5. **Triggers only fire on transitions.** Time (an SLA breach, a deadline), external events (a customer replied, a PR was merged) and metric thresholds are also sources. Not designed.
6. **Cancellation of active work from outside** (an external event cancels a unit mid-attempt) is not designed. Neither is preemption by the scheduler.
7. **Deadlines, SLAs and per-unit cost ceilings** are not inputs anywhere. Quota is per account; nothing caps what one unit may spend.
8. **Shared accounts across harnesses.** Account quota state lives in each harness's ledger, so two projects sharing a subscription double-count. Account state may need its own shareable backend, separate from the ledger.
9. **The learning loop has no capture entity.** `.record()` lets an agent write, and the supervisor can write; nothing turns outcomes into candidate memories automatically (a failed attempt proposing an experience item). Triggers to journals would do it; the connection is not drawn.
10. **Execution vocabulary is loose.** Run, attempt, invocation, step: four words for levels of execution, used without definitions. The ledger needs them defined.
11. **A handler flow's `.input()` duplicates the lane's kind.** `H.flow.for(Bug)` or the lane supplying the input type would remove the repetition and the chance of mismatch.
12. **Journal reads union across journals of a kind, writes need one destination.** Justified, but asymmetric and unstated in the DSL.
13. **Perpetual units.** A long-lived unit (a running service, a tenancy) that is never terminal does not fit a skeleton of pending/active/terminal. Multi-outcome units (an experiment ending in A, B or inconclusive) fit badly: mapping inconclusive to failed is a lie.
14. **Observers are the one non-entity.** Board and telemetry are functions; alerting (Slack on failure) and webhooks would be more of the same. Possibly fine as "subscriber" shape; possibly a missing noun.
15. **The supervisor's client hides its transport.** A dashboard client would need HTTP, not MCP. Maybe fine; maybe transport is a separate thing.
16. **Startup validation is implicit.** Name collisions (derived descriptors keep their name), transitions outside the kind's states, a trigger on a lane that is not registered: all should fail at `start()`, none is specified.
17. **Journal is the weakest noun in the set.** Curated items are not a journal.
