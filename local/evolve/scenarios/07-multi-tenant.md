# Scenario 7: two projects, shared subscriptions

The owner runs two independent product harnesses (two repositories, two ledgers, two supervisors) that share the same three Claude subscription accounts.

## Must express

- Each harness declares the same three accounts. Account quota state (utilization windows, cooldowns) is shared between the two harnesses: if harness A drives an account into cooldown, harness B sees it. Project share caps are per harness: A may use 60% of an account's window, B 30%.
- Each harness has its own ledger (runs, attempts, telemetry) in its own SQLite file. Neither can see the other's runs.
- Fair scheduling across tenants is not the kernel's job (they are separate processes), but each scheduler must respect account eligibility that the other may have changed a second ago.
- Harness A is the coding team of scenario 1. Harness B is a documentation harness: kind DocPage, supplied from a folder, handled by a writer agent and a link-check command, stored in the folder's frontmatter.
- A shared taste journal: both harnesses recall the owner's taste from one JSONL file; each has its own experience journal.
- The owner's one supervisor session can be pointed at either harness (two control API endpoints) and sees the shared account state from both.

## Hostile aspects

- Account state that outlives and spans harnesses: where does it live, and is that a second kernel store or a backend of the ledger?
- Two ledgers, one memory store, three shared accounts: the design must say which entity owns which state without new ad-hoc concepts.
- The same entity definitions (accounts, taste journal) imported by two harness files from a shared module.
