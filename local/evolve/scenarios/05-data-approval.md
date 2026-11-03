# Scenario 5: data job with approval

A nightly data job with one human gate in the middle and a retry policy.

## Must express

- Kind NightlyLoad, supplied by a schedule at 02:00, one unit per source system (four). State in the harness's store.
- Handler: extract (command, SSH runner), validate (command), then a model call that writes a plain-language summary of anomalies, then halt for a human to approve the load, then load (command), then verify (command).
- Retry: extract and load retry up to 3 times with exponential backoff on failure, as a policy on the step, not hand-written in the command. A validation failure does not retry; it halts for a human with the validation report.
- Outcome: loaded, loaded with warnings (verify found tolerable drift), rejected by the approver, or failed. Loaded with warnings is a success for scheduling purposes but must be distinguishable in metrics and on the board.
- A unit left waiting for approval past 09:00 is cancelled by a time trigger and a new one is not created until the next night.
- Resumability: if the harness process restarts while a unit is blocked on approval, the unit is still blocked after restart and resumes at the same step when approved.
- The approver works through the supervisor; the summary agent recalls taste about what the approver wants emphasised.

## Hostile aspects

- Retry with backoff as a declared policy on a step.
- Restart survival of a blocked attempt.
- A success-with-warnings outcome that is success to the scheduler and distinct to metrics.
- A time trigger that cancels, scoped to one kind.
