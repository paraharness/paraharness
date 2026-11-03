# Scenario 10: the power goes off

A release harness is killed mid-attempt (power cut, OOM, `kill -9`, laptop closed) and started again. This scenario states what must be true after the restart. It does not say how; a variant that satisfies every line by any mechanism passes, and its design.md must name the mechanism and what the harness author had to write for it.

## Must express

- Kind Release, supplied by the operator. Its flow, in order: `build` (a command that is safe to run twice), `announce` (a command that posts a message to a channel; posting twice is wrong), `review` (an agent on a model), `approval` (a halt for a release manager), `summarize` (a model call submitted to a batch API and collected later), then it spawns one Smoke unit per platform in a `smoke` lane and waits for them.
- After a restart, a step that completed before the crash is not run again and costs nothing.
- The step that was running at the crash is handled per step, declared by the harness author on the step or the command: rerun it (`build`), never rerun it and park the attempt for the supervisor (`announce`, unless the harness can tell that the post happened, in which case it continues), or ask the step's driver whether it finished (`review`: the agent's session may have completed while the harness was down).
- An `approval` halt resolved while the harness was down is found on restart and the flow continues from it.
- A `summarize` batch submitted before the crash is collected, not resubmitted.
- A resumed attempt is the same attempt: one id, one row in every metric, and the crash is never counted as a model failure or an agent failure.
- Smoke children that finished while the parent was down are seen by the parent on restart; children still running are not restarted.
- An attempt whose flow definition changed between the crash and the restart (a step renamed, a step inserted before the one that was running) is not silently rerun. It is parked for the supervisor with a reason, and the supervisor can restart it from the top or abandon it.
- The harness author writes no resumption code: no checkpoint, no "if already done" branch in a flow, no reading of the ledger from a flow.
- Two copies of the harness started against the same ledger by mistake: the second refuses to start, or takes over from a dead first, and never both run.

## Hostile aspects

- Effects of three kinds (safe to repeat, wrong to repeat, outside the harness's control) in one flow, each with its own restart behaviour, declared by the author and enforced by the kernel.
- State that moved while the harness was down (a halt resolved, a batch completed, a child finished) and must be found, not replayed from memory.
- A definition that changed under a running attempt.
- Single-writer exclusion over a shared ledger.
- Everything above must hold with the ledger as the only kernel state (principle 15), and the author must have nothing to write for it (principle 2).
