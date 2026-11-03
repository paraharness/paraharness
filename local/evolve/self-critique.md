# Known weaknesses of the owner's seed (ours-2, as of 2026-11-01 after run one)

Fed to the adversary as "known; find what we did not see", and to mutation as targets.

1. **Seat and agent overlap.** An agent is "a seat with one model"; two nouns for one pivot unless the seat earns its place in every scenario that compares models.
2. **Job and batch overlap.** A batch of model calls is a submit-and-collect job; two step kinds where one may do.
3. **Halt as an entity and halt as a step.** `H.halt(name)` is referenced by identity, but a flow may halt at the same question twice; the address of a halt in a flow and the halt entity are two things.
4. **Resources map to adapters.** `H.resource('edge')` is pure name; the lease plugin maps it to globs. Two harnesses may map one resource differently, and nothing checks the mapping covers every resource the kinds touch.
5. **Pool serves models.** `pool.serves(...models)` is a relationship on an instance; whether it belongs on the pool, the model or a named pivot is undecided.
6. **Retry bound on the lane, exit map on the lane.** The lane now carries kind, suppliers, store, handler, exits, retry, WIP and ceiling; the adversaries called a lane with eight concerns overloaded.
7. **Multi-attempt units.** An Epic that spawns and re-enters, a Negotiation of many rounds: the flow re-enters from the top and must find where it is from recorded results; whether that needs a `loopback` pivot, as one evolved variant has, is open.
8. **The supervisor's client hides its transport**, still; two supervisors on one session (scenario 7) have no entity.
9. **Startup validation is listed, not specified.** Name collisions, exits outside the kind's states, a trigger on an unregistered lane, a facet repeating a column, an agent no pool serves: all should fail at `start()`.
10. **Memory capture** is a trigger consequence (`journal.record`); nothing turns outcomes into candidate memories without an author writing the trigger.
