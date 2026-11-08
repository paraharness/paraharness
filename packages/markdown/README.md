# `@paraharness/markdown`

Frontmatter and section-aware Markdown source loaders for ParaHarness global rules, partition/effect-scoped rules, and on-demand skills.

- **Full API Reference:** [https://paraharness.github.io/paraharness/modules/_paraharness_markdown.html](https://paraharness.github.io/paraharness/modules/_paraharness_markdown.html)

## Installation

```bash
pnpm add @paraharness/markdown @paraharness/core zod
```

## Usage

```ts
import { P } from '@paraharness/core';
import { md, markdownExecutors } from '@paraharness/markdown';

const repoRules = P.rules('repo-rules')
  .global(md.globalRules('.harness/rules/global/*.md'))
  .scoped(md.scopedRules('.harness/rules/scoped/*.md'));

const sharedSkills = md.skills('.harness/skills/*.md');
```

## Key Exports

| Export | Description |
| :--- | :--- |
| `md.globalRules(pathOrGlob)` | Loads validated `GlobalRule[]` from Markdown files |
| `md.scopedRule(path)`, `md.scopedRules(glob)` | Loads frontmatter-configured `ScopedRule` / `ScopedRule[]` descriptors |
| `md.skill(path)`, `md.skills(glob)` | Loads frontmatter-configured `SkillNode` / `SkillNode[]` descriptors |
| `md.frontmatter(pathOrGlob)`, `md.section(path, heading)` | Low-level Markdown frontmatter and heading section source builders |
| `markdownExecutors` | Runtime source executor registrations for `markdown:frontmatter` and `markdown:section` |

## License

[MIT](./LICENSE) © Tornike Tsomaia
