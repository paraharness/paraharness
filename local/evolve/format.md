# Variant format

A variant is a directory. You produce it as a sequence of files, each wrapped exactly like this, with nothing outside the wrappers:

=== FILE: design.md ===
...contents...
=== END ===

Required files:

- `design.md`: the entities (kinds, instances, pivots), the rules, and two mandatory sections: `## What changed and why` (versus the parent; for a seed, versus the brief) and `## Principles broken` (each principle number you knowingly violate, with the reason, or the word "none").
- `h.d.ts`: ambient TypeScript declarations for every module a scenario imports. The kernel is `declare module 'harness-dsl' { ... }`; adapters are `declare module 'harness-dsl/<name>' { ... }`, one block each. `zod` is available as `import { z } from 'zod'` inside the kernel block. These declarations are the DSL: full generics, full inference. `any` in a declaration is counted against you. Keep the surface as small as the battery allows.
- `kernel.d.ts`: the interfaces a backend implements (`Ledger`, `Supplier`, `Store`, `MemoryStore`, `Policy`, `Metrics`, `Client`, and whatever your design needs). Compiled with strict settings. This is what proves the design is implementable. Write it either as a plain module with top-level `export`s, which `h.d.ts` and adapters may import as `'harness-dsl/kernel'`, or as a `declare module 'harness-dsl/kernel' { ... }` block; both resolve.
- The installed zod is **version 4**: `z.ZodType<Output, Input = unknown>` has no `ZodTypeDef` parameter; use `z.infer<typeof schema>` or `z.output<T>` for inferred types. Node globals (`fetch`, `URL`, `Buffer`) are available in scenario files; `process.env` is still forbidden.
- `scenarios/<nn>-<name>.ts`: one file per scenario in the battery, numbered as the battery is, each a complete harness that compiles against `h.d.ts` with `strict: true`, `noImplicitAny: true`, and no `as`, `any`, `!` or `@ts-` anywhere. A scenario you cannot express gets a file containing only a comment that starts `// CANNOT EXPRESS:` followed by the reason; that scores as missing coverage, which is better than a lie.

Rules:

- No comments in `.ts` files other than the `CANNOT EXPRESS` marker. Names carry the meaning.
- Scenario files import only from `harness-dsl`, `harness-dsl/*` and `zod`.
- Every value read from the environment is a reference (`H.env`-shaped), never `process.env`.
- Vendor, product, file-format and tool names appear only inside `harness-dsl/<adapter>` blocks, never inside `declare module 'harness-dsl'`.
