# @paraharness/markdown

Frontmatter and section-aware Markdown source loaders for [Paraharness](https://github.com/paraharness/paraharness). This package parses YAML frontmatter and Markdown sections to load global rules, partition- and glob-scoped rules, and pull-based skills into `P.rules`, `P.scopedRule`, `P.skill`, and `P.agent`.

## Installation

With npm:

```bash
npm install @paraharness/markdown @paraharness/core zod
```

With yarn:

```bash
yarn add @paraharness/markdown @paraharness/core zod
```

With pnpm:

```bash
pnpm add @paraharness/markdown @paraharness/core zod
```

## Usage

```ts
import { P, z } from '@paraharness/core';
import { createExecutorRegistry } from '@paraharness/core/runtime';
import { claude, claudeExecutors } from '@paraharness/claude';
import { md, markdownExecutors } from '@paraharness/markdown';

const sonnet = claude.model('sonnet', { id: 'claude-sonnet-4-6' });

const repoRules = P.rules('repo-rules')
  .global(md.globalRules('.harness/rules/global/*.md'))
  .scoped(md.scopedRules('.harness/rules/scoped/**/*.md'));

const dbMigrationSkill = P.skill(md.skill('.harness/skills/db-migrations/SKILL.md')).lease(
  'until-completed-or-fork-exit',
);

const sharedSkills = md.skills('.harness/skills/shared/*.md');

const worker = P.agent('worker')
  .model(sonnet)
  .rules(repoRules)
  .skills(dbMigrationSkill, sharedSkills)
  .instructions(md.section('ARCHITECTURE.md', 'Implementation Guidelines'))
  .input(z.object({ prompt: z.string() }))
  .output(z.object({ summary: z.string() }));

const registry = createExecutorRegistry(claudeExecutors, markdownExecutors);
```

## Documentation

See the [`@paraharness/markdown` API Reference](https://paraharness.github.io/paraharness/modules/_paraharness_markdown.html) for full type and builder specifications.

## License

[MIT](./LICENSE) © Tornike Tsomaia
