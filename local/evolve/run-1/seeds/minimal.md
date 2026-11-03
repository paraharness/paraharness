# Seed: the smallest surface that holds

Design harness-dsl with the fewest entities that can express the entire battery without escape hatches and without breaking a principle. Start by assuming eight nouns is too many and see what the battery forces back in.

Questions to answer in `design.md`, each with the entity you removed or kept and why:

- Is `state` an entity, or is a lifecycle a plain declared map on the kind, with triggers attaching to (kind, stateName)?
- Is `role` separate from `agent`, or is an agent a role whose model is a late-bound parameter of the lane?
- Are `pool`, `scheduler`, `recall` and model choice four uses of one `policy`, and is `pool` itself needed, or is it a policy over a list?
- Is `journal` distinct from `lane`? Both are "a kind × a store × a policy". Could memory be a kind of work whose units are memory items, handled by a recall policy, so that one pivot serves both? Say what that would cost in honesty and in ergonomics.
- Is `trigger` distinct from a step in a flow that happens to create work in another lane? What is lost if triggers are only `on(lane.enters(state))` and what is gained if they are also a flow combinator?
- Is `supervisor` an entity, or a client adapter with a grant list?
- Do flows need `.input()` when the lane already knows the kind?

Constraints that do not bend: adapters outside `H.*`; kinds carry no backend; every pivot named; deterministic policies with sample counts in metrics; the five-outcome skeleton or an explicit, justified replacement; scenario 4 with no model anywhere.

Deliver the smallest `h.d.ts` you can defend, and a `design.md` that lists every entity you considered and cut.
