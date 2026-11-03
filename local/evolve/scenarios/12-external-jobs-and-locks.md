# Scenario 12: long external jobs, and work under locks

An ML platform team. Drafted for run two from the generation 2 and 3 critiques: long external effects that are neither model, human nor batch; and shared-database maintenance, proposed in two generations by independent adversaries.

## Must express

- Kind EvalRun, supplied by the operator, stored in the harness store. Flow: `prepare` (command), `submit` (a command that hands a job to an external GPU service and gets a job id; the job runs 2 to 8 hours), `collect` (the result, polled every 10 minutes), `score` (command), `summarize` (model).
- While the job runs the unit holds no WIP and no runner slot; the lane has WIP 2 and keeps starting new runs. On restart a submitted job is collected, not resubmitted. A job failing remotely is an attempt failure; a harness crash while it runs is not.
- Kind Migration, supplied from a folder of migration files in order. Each takes an exclusive lock on one named database; two migrations on one database never overlap, migrations on different databases run concurrently. A migration is wrong to repeat: after a crash mid-migration the attempt is parked for the supervisor with what was recorded, never rerun.
- Kind Backfill, supplied by the operator, one unit per table, in batches of 10,000 rows. A backfill takes a shared lock on its database that a Migration's exclusive lock excludes and is excluded by. A backfill interrupted by a crash resumes at the next batch, not the first; the author writes no checkpoint.
- Ordering across units: migration 0042 must not start before 0041 has succeeded, whatever order the folder is read in; a failed 0041 parks 0042 with a reason.
- Metrics: hours of GPU jobs in flight per day with sample counts; lock wait time per database.

## Hostile aspects

- An external effect with submit and collect semantics, in the kernel's vocabulary, holding no capacity while it runs.
- Locks on named resources shared by kinds, exclusive and shared, with the lease as kernel state and the resource as an entity.
- Non-idempotent effects whose restart behaviour is declared by the author and enforced by the kernel.
- Ordering declared between units of one kind, with a parked unit carrying its reason.
- Batch-shaped resumption inside one attempt without checkpoint code in the flow.
