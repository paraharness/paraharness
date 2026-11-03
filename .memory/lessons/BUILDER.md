Read by every BUILDER as its first step and again after a compaction; read again by whoever adds a line. One sentence per lesson, "Do X, because Y", Y the mechanism that bites; present tense; no date, ticket, PR, person or quote. A lesson that needs a second sentence is two lessons or not yet general. Ids are never reused. (Every TIC- id in this file is a placeholder for a real issue id.)
Good: - B3: Read the architecture doc of the area before changing it, because its invariants are not visible in the files you touch.
Good: - B4: Stage only the files you wrote before pushing the memory checkout, because a blanket add sweeps other sessions' half-written files into your commit.
Bad:  - "After the TIC-037 PR sat two days and conflicted, check Mergify's reply." (an incident with an id)
Bad:  - "Be careful with merges, since conflicts arise in several ways." (no X, no mechanism)

- B21: Never gate a check, a proof or a re-run on the host's load falling, run it under the load as it is and re-run a timed-out file alone, because the shared host stays loaded for hours by other sessions' suites and a wait-for-load loop idles the ticket for its whole timeout while nothing reports it.
