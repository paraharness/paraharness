# harness-dsl design evolution loop

Evolves the DSL surface against a fixed scenario battery. Fitness is mostly mechanical (TypeScript compiles, no escape hatches, surface size, coverage, principle checks); models generate variants and critique them adversarially; pairwise judges rank; the owner picks at checkpoints.

## Files

- `principles.md`: the owner's decisions; every variant is judged against them.
- `scenarios/*.md`: the battery, twelve harnesses every variant must express. 08 breaks the lifecycle skeleton, 09 is a harness acting on its own metrics, 10 is a restart after a power cut, stated as requirements only, 11 is halts with a clock and bounded retry, 12 is external jobs and work under locks (11 and 12 added for run two).
- `rubric.md`: pairwise judging criteria, framings and output format.
- `format.md`: what a variant is (design.md, h.d.ts, kernel.d.ts, scenarios/*.ts) and its rules.
- `seeds/*.md`: starting briefs, materialized twice each in generation 0 (run one: ours, durable-execution lens, supervision-tree lens, minimal; run two: ours-2, the owner's design as ruled after run one). `seeds/<name>/`: a variant directory imported as it is (run two: the four members of run one's final front), given only the scenario files it lacks.
- `self-critique.md`: known weaknesses of the seed, fed to mutation and the adversary.
- `evolve.py`: the driver. `state.json`, `variants/`, `runs/` are its output. `run-1/` holds run one's state, variants, runs, seed briefs and self-critique; `runs/run-1-report.md` moved with them.

## One generation

1. **mutate**: generation 0 materializes each seed brief twice and imports each seed directory once; later generations give every front variant three children, each with a named operator (rename, merge, split, delete, scenario-fix, lens, surface-cut, inference) and the parent's critique. Three batches: the surface, then the scenario files in two halves, the second half written against the surface as the first half left it (one response cannot hold ten scenarios).
2. **compile**: local. Each variant is copied outside the package tree (so `import 'harness-dsl'` resolves to the variant's ambient declarations, not to `dist/`), symlinked to the project's `node_modules` for zod, and compiled with `strict`, `noImplicitAny`, Node types, and `harness-dsl/kernel` mapped to `kernel.d.ts` when it is a plain module. Materializing strips markdown fences around a file and rewrites zod 3's `z.ZodTypeDef` idiom to zod 4; both are version drift, not design, and every variant gets the same treatment. Counts: TS errors, escapes (`as any`, `: any`, `@ts-`, `!`), `any` in the d.ts, surface (exports + members of the kernel block), coverage (scenarios not marked `CANNOT EXPRESS`), principle strikes (vendor noun in the kernel block, `bind`/`wire`, `process.env`, kernel importing an adapter).
3. **repair**: one request per variant with compile errors, carrying the tsc output and the failing files; the answer is merged and recompiled. Two rounds; the second only for what the first left broken.
4. **critique**: one adversary request per compiling variant: worst scenario, a new scenario it cannot express, three concrete critiques. Stored with the variant and fed to its children.
5. **judge**: pairwise, every pair judged in both positions and counted only when both verdicts agree (judges favoured position A 71% of the time in generation 1), five criteria × five framings, three pairs per compiling variant, each on `design.md` + `h.d.ts` + two fixed scenarios (01, 08) + one random one. A verdict that is not parseable JSON with a winner is retried once. Bradley-Terry over all judgments so far, with one pseudo-game per variant against an average opponent so an undefeated variant's strength stays finite.
6. **select**: only variants with zero compile errors and full battery coverage are eligible; coverage is a gate, not a trade-off. The Pareto front over escapes, `any`, surface, strikes and BT comes first, then the best of the rest by BT, four parents in all, at most two per lineage (a lineage is a generation-0 ancestor); a lineage with no parent dies. With escapes, `any` and strikes all at zero the Pareto front alone is the best-judged variant plus the smallest surface, which is how generation 2 first collapsed to two parents. `runs/gNN-front.md` lists the parents with their critiques and marks which are on the Pareto front.

The driver stops after every fifth generation for the owner to read the front.

## Running

```sh
cd local/evolve
python3 evolve.py run --dry-run                         # writes runs/g00-mutate/requests.jsonl, submits nothing
python3 evolve.py run --generations 5 --max-usd-per-generation 7.5
python3 evolve.py run --generations 5                   # continues from state.json after the checkpoint
python3 evolve.py report
python3 evolve.py compile --variant variants/g00/g00-ours-0
python3 evolve.py reset                                 # wipes state, variants and runs
```

Spend: each stage is submitted through the batch runner with its own `--max-usd` (50% mutate, split 40/30/30 over surface and the two scenario halves; 15% repair, 10% critique, 30% judge of the per-generation cap). The runner submits in batches of at most $12 (after a one-request trial that measures the real cost), reads `ANTHROPIC_API_KEYS` from `~/.env`, caches the shared system prompt for an hour, and holds back requests that would pass the cap, estimating each unsent request at twice the measured mean; a stage cap therefore has to be about twice the expected spend, or the tail of the stage is held back and those children die. With the default shares, `--max-usd-per-generation 100` gives every stage that margin for 12 children; actual spend is about $40. Generation 0 measured about $14 for mutate (8 variants); a later generation with 18 children is about twice that.

Compile scratch defaults to `$TMPDIR/harness-dsl-evolve`; override with `EVOLVE_COMPILE_DIR`.

## Stopping

The driver runs the batch runner as a child process. Killing only the driver orphans the runner, which keeps polling and may still submit the stage it was on. Start the loop as its own process group and stop the whole group:

```sh
nohup python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' \
  python3 -u evolve.py run --generations 5 >> runs/loop.log 2>&1 &
echo $! > runs/loop.pid
kill -- -"$(cat runs/loop.pid)"
```

macOS has no `setsid` binary; the Python one-liner does the same. Append to `runs/loop.log` rather than truncate it so a `tail -f` on it keeps working.

A batch already accepted by the API runs to completion and is billed either way; re-running the same stage directory collects it instead of paying twice.
