# Scenario 2: support triage

Customer conversations arrive from a helpdesk webhook. Nothing here touches files.

## Must express

- One kind of work, Conversation, supplied by a webhook (push) and by a periodic poll of the helpdesk for anything the webhook missed. State lives in the helpdesk via its API; the harness holds nothing but its ledger.
- Lifecycle: new, classifying, drafting, awaiting approval, sent, closed by customer, escalated. A human approves every outgoing reply (halt), except for a category the policy marks safe after 200 approved samples with zero rejections.
- Two agents: a classifier on a cheap model, a drafter on a stronger one. The drafter recalls taste (tone, phrases to avoid) and experience ("when the customer mentions a refund older than 30 days, cite policy 4.2"). A reviewer role (human, through the supervisor) records taste from its edits.
- Deadlines: each conversation carries an SLA; the scheduler orders by time to breach, not by arrival. A breached SLA fires a trigger that escalates (creates an Escalation unit in another lane with its own handler and a human-only flow).
- External cancellation: if the customer replies while a draft is awaiting approval, the attempt is cancelled and the unit returns to classifying with the new message.
- Per-unit cost ceiling: no conversation may spend more than $0.40 of model cost; a unit that would exceed it halts for a human.
- Metrics the policy reads: approval rate by category and by model, with sample counts.

## Hostile aspects

- Cancellation from outside an active attempt.
- A trigger whose source is time (SLA breach), not a transition.
- A cost ceiling scoped to a unit, not an account.
- A lane whose handler contains no model call at all (Escalation).
