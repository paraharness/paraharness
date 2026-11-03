# Seed: supervision-tree lens

Design harness-dsl as if its authors came from Erlang/OTP and Elixir (GenServer, gen_statem, Supervisor, Registry, Broadway). Keep every principle in `principles.md`.

Ideas to take seriously, not copy blindly:

- The harness is a supervision tree. Lanes, suppliers, the scheduler and the supervisor client are children with restart strategies; a crashing supplier does not take down a lane. "Let it crash" applies to attempts: an attempt fails, the unit does not.
- A unit's lifecycle is a state machine (gen_statem) with explicit events, timeouts per state and actions on entry and exit. Triggers are what happens on state entry, declared next to the state or next to the lane.
- Mailboxes: a unit receives messages (external events, operator decisions, timers) while active; the handler decides what each message means in the current state. Cancellation is a message.
- Registries: units are addressable by kind and key, so a webhook can find the Negotiation it belongs to.
- Back-pressure: suppliers are producers with demand; the scheduler pulls what it can run (Broadway/GenStage). Nothing is pushed into a queue it cannot drain.
- Monitors and links: an Epic monitors its Features; when a Feature terminates, the Epic receives the exit reason and decides.

Still required: kinds, states as entities on the skeleton, a named pivot for work × supply × store × handler, memory as kinds with journals, deterministic policies, adapters outside `H.*`, an optional supervisor client.

Use the owner's vocabulary (work, unit, attempt, lane, trigger, journal) unless a lens word is clearly better; say so in `design.md` when you keep one.
