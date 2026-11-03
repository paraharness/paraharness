const WORDGRID = "import { createState } from '@wg/game-wordgrid';\nexport const make = createState;\n";
const PEEP = "import { peepState } from '@wg/game-peep';\nexport const make = peepState;\n";
const NODE_FS = "import { readFileSync } from 'node:fs';\nexport const read = readFileSync;\n";
const DB_MEMBER = 'export const read = (env: { DB_ACCOUNTS: unknown }) => env.DB_ACCOUNTS;\n';
const DB_DESTRUCTURE = 'export const read = ({ DB_CORE }: { DB_CORE: unknown }) => DB_CORE;\n';
const SET_QUERY_DATA = "export const write = (client: { setQueryData: (...args: unknown[]) => void }) => client.setQueryData(['k'], 1);\n";
const AWAIT_REFETCH =
  "export const options = (client: { invalidateQueries: () => Promise<void> }) => ({\n  onSuccess: async () => {\n    await client.invalidateQueries();\n  },\n});\n";
const RETURN_REFETCH =
  "export const options = (client: { invalidateQueries: () => Promise<void> }) => ({\n  onSettled: () => client.invalidateQueries(),\n});\n";
const RETURN_STATEMENT_REFETCH =
  "export const options = (client: { refetchQueries: () => Promise<void> }) => ({\n  onError: () => {\n    return client.refetchQueries();\n  },\n});\n";
const VOID_REFETCH =
  "export const options = (client: { invalidateQueries: () => Promise<void> }) => ({\n  onSuccess: () => {\n    void client.invalidateQueries();\n  },\n});\n";
const ON_MUTATE =
  "declare function useMutation(options: unknown): unknown;\nexport const useThing = () => useMutation({ onMutate: () => undefined });\n";
const CARD = "declare function Card(props: Record<string, unknown>): null;\n";
const JSX_LITERAL_PROP = CARD + "export const View = () => <Card title=\"Hello there\" />;\n";
const JSX_TEMPLATE_PROP = CARD + "export const View = ({ name }: { name: string }) => <Card label={`Play ${name}`} />;\n";
const JSX_GLUED_PROP = CARD + "export const View = ({ name }: { name: string }) => <Card hint={'a' + name} />;\n";
const JSX_TWO_HOLES = CARD + "export const View = ({ a, b }: { a: string; b: string }) => <Card body={`${a}${b}`} />;\n";
const JSX_TRANSLATED_PROP = CARD + "export const View = ({ t }: { t: (k: string) => string }) => <Card title={t('card.title')} />;\n";
const JSX_CHILD_LITERAL = 'export const View = () => <p>Hello there</p>;\n';
const GAME_TOKEN_TILE = 'export const paint = (theme: { colors: { tileBackground: string } }) => theme.colors.tileBackground;\n';
const GAME_TOKEN_SURFACE = 'export const paint = (surface: { colors: string }) => surface.colors;\n';
const BOOT_WRITE = "export const script = 'document.write(1)';\nexport const templated = `document.write(${1})`;\n";
const IMPORT_ORDER = "import { b } from './b';\nimport { z } from 'zod';\nexport const both = [b, z];\n";
const RULES_OF_HOOKS = "export const View = (on: boolean) => {\n  if (on) useThing();\n  return null;\n};\ndeclare function useThing(): void;\n";
const EQEQEQ = 'export const same = (a: number, b: number) => a == b;\n';
const UNUSED = 'export const used = 1;\nconst unused = 2;\n';
const IMPORT_DUPLICATES = "import { a } from './a';\nimport { b } from './a';\nexport const both = [a, b];\n";
const REACT_BASE = "import { Component } from 'react';\n";
const NO_RENDER_RETURN = REACT_BASE + 'export class Panel extends Component {\n  render() {}\n}\n';
const DEPRECATED_API = REACT_BASE + 'export class Legacy extends Component {\n  componentWillMount() {}\n  render() {\n    return null;\n  }\n}\n';
const NO_UNDEF_JS = 'export const x = missingGlobal;\n';
const E2E_SLEEP = "declare const page: { waitForTimeout(ms: number): Promise<void> };\nexport async function open(): Promise<void> {\n  await page.waitForTimeout(400);\n}\n";
const E2E_HOLD = "import type { Page } from '@playwright/test';\n\nexport async function holdFor(page: Page, ms: number, why: string): Promise<void> {\n  void why;\n  await page.waitForTimeout(ms);\n}\n";

const E2E_TIMER_CALL = 'export const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 400));\n';
const E2E_TIMER_CALL_JS = 'export const pause = () => new Promise((resolve) => setTimeout(resolve, 400));\n';
const E2E_TIMER_MEMBER = 'export const pause = () => new Promise<void>((resolve) => globalThis.setInterval(resolve, 400));\n';
const E2E_TIMERS_IMPORT = "import { setTimeout as sleep } from 'node:timers/promises';\n\nexport const pause = () => sleep(400);\n";
const E2E_TIMERS_PLAIN_IMPORT = "import { setTimeout as sleep } from 'timers';\n\nexport const pause = () => sleep(400);\n";
const E2E_TEST_TIMEOUT = "import { test } from '@playwright/test';\n\ntest.setTimeout(120_000);\n";
const E2E_HOLD_USE = "import { holdFor } from '../helpers';\n\nexport const hold = holdFor;\n";

export const REJECTED = [
  { path: 'apps/app/src/features/boundary-wordgrid.ts', source: WORDGRID, rule: 'no-restricted-imports', message: 'game-wordgrid' },
  { path: 'apps/app/src/features/boundary-peep.ts', source: PEEP, rule: 'no-restricted-imports', message: 'game-peep' },
  { path: 'apps/edge/src/routes/boundary-wordgrid.ts', source: WORDGRID, rule: 'no-restricted-imports', message: 'game-wordgrid' },
  { path: 'packages/shared/src/node-builtin.ts', source: NODE_FS, rule: 'no-restricted-imports', message: 'isomorphic' },
  { path: 'apps/edge/src/routes/db-member.ts', source: DB_MEMBER, rule: 'no-restricted-syntax', message: 'DB_* binding' },
  { path: 'apps/edge/src/routes/db-destructure.ts', source: DB_DESTRUCTURE, rule: 'no-restricted-syntax', message: 'DB_* binding' },
  { path: 'apps/app/src/features/cache-write.ts', source: SET_QUERY_DATA, rule: 'no-restricted-syntax', message: 'api/cache/' },
  { path: 'apps/app/src/games/wordgrid/cache-write.ts', source: SET_QUERY_DATA, rule: 'no-restricted-syntax', message: 'api/cache/' },
  { path: 'apps/app/src/features/awaited-refetch.ts', source: AWAIT_REFETCH, rule: 'no-restricted-syntax', message: 'await (or return) a refetch' },
  { path: 'apps/app/src/features/returned-refetch.ts', source: RETURN_REFETCH, rule: 'no-restricted-syntax', message: 'await (or return) a refetch' },
  { path: 'apps/app/src/features/returned-refetch-statement.ts', source: RETURN_STATEMENT_REFETCH, rule: 'no-restricted-syntax', message: 'await (or return) a refetch' },
  { path: 'apps/app/src/api/cache/awaited-refetch.ts', source: AWAIT_REFETCH, rule: 'no-restricted-syntax', message: 'await (or return) a refetch' },
  { path: 'apps/app/src/api/optimistic.ts', source: AWAIT_REFETCH + ON_MUTATE.replace('export const useThing', 'export const useOther'), rule: 'no-restricted-syntax', message: 'await (or return) a refetch', absent: 'useOptimisticMutation' },
  { path: 'apps/app/src/features/on-mutate.ts', source: ON_MUTATE, rule: 'no-restricted-syntax', message: 'useOptimisticMutation' },
  { path: 'apps/app/src/features/literal-prop.tsx', source: JSX_LITERAL_PROP, rule: 'no-restricted-syntax', message: 'must come from t()' },
  { path: 'apps/app/src/features/template-prop.tsx', source: JSX_TEMPLATE_PROP, rule: 'no-restricted-syntax', message: 'must come from t()' },
  { path: 'apps/app/src/features/glued-prop.tsx', source: JSX_GLUED_PROP, rule: 'no-restricted-syntax', message: 'Glued-together copy' },
  { path: 'apps/app/src/features/two-holes-prop.tsx', source: JSX_TWO_HOLES, rule: 'no-restricted-syntax', message: 'Glued-together copy' },
  { path: 'apps/app/src/features/child-literal.tsx', source: JSX_CHILD_LITERAL, rule: 'jsx-no-literals' },
  { path: 'apps/app/src/games/wordgrid/token-tile.ts', source: GAME_TOKEN_TILE, rule: 'no-restricted-syntax', message: 'useSurface()' },
  { path: 'apps/app/src/games/peep/token-surface.ts', source: GAME_TOKEN_SURFACE, rule: 'no-restricted-syntax', message: 'useSurface()' },
  { path: 'apps/app/src/ui/theme/boot-script.ts', source: BOOT_WRITE, rule: 'no-restricted-syntax', message: 'insertAdjacentHTML', count: 2 },
  { path: 'apps/app/src/features/import-order.ts', source: IMPORT_ORDER, rule: 'order' },
  { path: 'apps/app/src/features/hooks.tsx', source: RULES_OF_HOOKS, rule: 'rules-of-hooks' },
  { path: 'apps/app/src/features/eqeqeq.ts', source: EQEQEQ, rule: 'eqeqeq' },
  { path: 'apps/app/src/features/unused.ts', source: UNUSED, rule: 'no-unused-vars' },
  { path: 'apps/app/src/features/duplicates.ts', source: IMPORT_DUPLICATES, rule: 'no-duplicates' },
  { path: 'apps/app/src/features/no-render-return.tsx', source: NO_RENDER_RETURN, rule: 'require-render-return' },
  { path: 'apps/app/src/features/deprecated-api.tsx', source: DEPRECATED_API, rule: 'no-deprecated' },
  { path: 'infra/scripts/no-undef.mjs', source: NO_UNDEF_JS, rule: 'no-undef' },
  { path: 'apps/app/e2e/sleeps.spec.ts', source: E2E_SLEEP, rule: 'no-restricted-syntax', message: 'holdFor' },
  { path: 'apps/app/e2e/sleeps-kit.ts', source: E2E_SLEEP, rule: 'no-restricted-syntax', message: 'holdFor' },
  { path: 'apps/app/e2e/local-hold.spec.ts', source: E2E_HOLD, rule: 'no-restricted-syntax', message: 'holdFor' },
  { path: 'apps/app/e2e/computed-sleep.spec.ts', source: E2E_SLEEP.replace('page.waitForTimeout(400)', "page['waitForTimeout'](400)"), rule: 'no-restricted-syntax', message: 'holdFor' },
  { path: 'apps/app/e2e/journeys/timer-call.spec.ts', source: E2E_TIMER_CALL, rule: 'no-restricted-syntax', message: 'A timer in a test' },
  { path: 'apps/app/e2e/journeys/timer-member.ts', source: E2E_TIMER_MEMBER, rule: 'no-restricted-syntax', message: 'A timer in a test' },
  { path: 'apps/app/e2e/journeys/timers-import.ts', source: E2E_TIMERS_IMPORT, rule: 'no-restricted-syntax', message: 'A timer in a test' },
  { path: 'apps/app/e2e/journeys/timers-plain-import.ts', source: E2E_TIMERS_PLAIN_IMPORT, rule: 'no-restricted-syntax', message: 'A timer in a test' },
  { path: 'apps/app/e2e/journeys/sleeps.spec.ts', source: E2E_SLEEP, rule: 'no-restricted-syntax', message: 'holdFor' },
  { path: 'apps/app/e2e/journeys/hold-for.spec.ts', source: E2E_HOLD_USE, rule: 'no-restricted-syntax', message: 'A journey never holds' },
  { path: 'apps/app/e2e/full/timer-call.spec.ts', source: E2E_TIMER_CALL, rule: 'no-restricted-syntax', message: 'A timer in a test' },
  { path: 'apps/app/e2e/full/timer-member.ts', source: E2E_TIMER_MEMBER, rule: 'no-restricted-syntax', message: 'A timer in a test' },
  { path: 'apps/app/e2e/full/timers-import.ts', source: E2E_TIMERS_IMPORT, rule: 'no-restricted-syntax', message: 'A timer in a test' },
  { path: 'apps/app/e2e/full/timers-plain-import.ts', source: E2E_TIMERS_PLAIN_IMPORT, rule: 'no-restricted-syntax', message: 'A timer in a test' },
  { path: 'apps/app/e2e/full/sleeps.spec.ts', source: E2E_SLEEP, rule: 'no-restricted-syntax', message: 'holdFor' },
  { path: 'apps/app/e2e/tools/sleeps.ts', source: E2E_SLEEP, rule: 'no-restricted-syntax', message: 'holdFor' },
  { path: 'apps/admin/e2e/timer-call.ts', source: E2E_TIMER_CALL, rule: 'no-restricted-syntax', message: 'A timer in a test' },
  { path: 'apps/admin/e2e/timers-import.ts', source: E2E_TIMERS_IMPORT, rule: 'no-restricted-syntax', message: 'A timer in a test' },
  { path: 'apps/admin/e2e/journeys/timer-call.spec.ts', source: E2E_TIMER_CALL, rule: 'no-restricted-syntax', message: 'A timer in a test' },
  { path: 'apps/admin/e2e/journeys/timer-member.ts', source: E2E_TIMER_MEMBER, rule: 'no-restricted-syntax', message: 'A timer in a test' },
  { path: 'apps/admin/e2e/journeys/timers-import.ts', source: E2E_TIMERS_IMPORT, rule: 'no-restricted-syntax', message: 'A timer in a test' },
  { path: 'apps/admin/e2e/journeys/sleeps.spec.ts', source: E2E_SLEEP, rule: 'no-restricted-syntax', message: 'holdFor' },
  { path: 'apps/admin/e2e/journeys/computed-sleep.spec.ts', source: E2E_SLEEP.replace('page.waitForTimeout(400)', "page['waitForTimeout'](400)"), rule: 'no-restricted-syntax', message: 'holdFor' },
  { path: 'apps/admin/e2e/journeys/hold-for.spec.ts', source: E2E_HOLD_USE, rule: 'no-restricted-syntax', message: 'A journey never holds' },
];

export const ALLOWED = [
  { path: 'apps/app/src/games/wordgrid/boundary-ok.ts', source: WORDGRID },
  { path: 'apps/app/src/games/peep/boundary-ok.ts', source: PEEP },
  { path: 'apps/edge/src/games/modules/boundary-ok.ts', source: WORDGRID },
  { path: 'apps/app/src/features/boundary.test.ts', source: WORDGRID },
  { path: 'packages/shared/scripts/node-builtin-ok.ts', source: NODE_FS },
  { path: 'packages/languages/src/node.ts', source: NODE_FS },
  { path: 'apps/edge/src/db/db-ok.ts', source: DB_MEMBER },
  { path: 'apps/edge/test/db-ok.ts', source: DB_DESTRUCTURE },
  { path: 'apps/app/src/api/cache/cache-write-ok.ts', source: SET_QUERY_DATA },
  { path: 'apps/app/src/api/cache/void-refetch-ok.ts', source: VOID_REFETCH },
  { path: 'apps/app/src/features/void-refetch-ok.ts', source: VOID_REFETCH },
  { path: 'apps/app/src/features/translated-prop.tsx', source: JSX_TRANSLATED_PROP },
  { path: 'apps/app/src/features/literal-prop.test.tsx', source: JSX_LITERAL_PROP },
  { path: 'apps/app/src/features/on-mutate.test.ts', source: ON_MUTATE },
  { path: 'apps/app/src/ui/theme/colour-reader.ts', source: GAME_TOKEN_TILE },
  { path: 'apps/app/e2e/helpers.ts', source: E2E_HOLD },
  { path: 'apps/app/e2e/full/hold-for-ok.spec.ts', source: E2E_HOLD_USE },
  { path: 'apps/app/e2e/full/test-timeout-ok.spec.ts', source: E2E_TEST_TIMEOUT },
  { path: 'apps/app/e2e/journeys/test-timeout-ok.spec.ts', source: E2E_TEST_TIMEOUT },
  { path: 'apps/admin/e2e/journeys/test-timeout-ok.spec.ts', source: E2E_TEST_TIMEOUT },
  { path: 'apps/app/e2e/live/timer-ok.ts', source: E2E_TIMER_CALL },
  { path: 'apps/app/e2e/visual/timer-ok.ts', source: E2E_TIMER_CALL },
  { path: 'apps/app/e2e/tools/timer-ok.ts', source: E2E_TIMER_CALL },
  { path: 'apps/app/e2e/walk-mock.spec.ts', source: E2E_TIMER_CALL },
  { path: 'apps/app/e2e/static-server.mjs', source: E2E_TIMER_CALL_JS },
  { path: 'apps/app/src/features/ordered.ts', source: "import { z } from 'zod';\n\nimport { b } from './b';\n\nexport const both = [b, z];\n" },
];
