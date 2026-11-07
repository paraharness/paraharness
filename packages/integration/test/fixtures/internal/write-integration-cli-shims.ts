import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PNPM_SHIM_SCRIPT } from './integration-workspace-seed.constants.js';

/**
 * Builds the executable Node.js `gh` CLI shim script bound to `ghPrsLogPath`.
 *
 * Emulates `gh pr view` and `gh pr create` against the JSON log file at `ghPrsLogPath`.
 *
 * @param {string} ghPrsLogPath - Absolute path to the JSON file storing created pull requests.
 *
 * @returns {string} Executable Node.js script source for the `gh` shim.
 */
function buildGhShimScript(ghPrsLogPath: string): string {
  return [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    `const logPath = ${JSON.stringify(ghPrsLogPath)};`,
    'const args = process.argv.slice(2);',
    "const prs = JSON.parse(fs.readFileSync(logPath, 'utf8'));",
    "if (args[0] === 'pr' && args[1] === 'view') {",
    '  const head = args[2];',
    "  const found = prs.some((p) => p.head === head && (p.state === 'OPEN' || p.state === 'MERGED'));",
    "  process.stdout.write(found ? 'true\\n' : 'false\\n');",
    '  process.exit(0);',
    '}',
    "if (args[0] === 'pr' && args[1] === 'create') {",
    '  const getOpt = (flag) => {',
    '    const i = args.indexOf(flag);',
    "    return i >= 0 ? args[i + 1] : '';",
    '  };',
    '  prs.push({',
    "    base: getOpt('--base'),",
    "    head: getOpt('--head'),",
    "    title: getOpt('--title'),",
    "    body: getOpt('--body'),",
    "    state: 'OPEN',",
    '  });',
    '  fs.writeFileSync(logPath, JSON.stringify(prs, null, 2));',
    "  process.stdout.write('https://github.com/acme/app/pull/' + prs.length + '\\n');",
    '  process.exit(0);',
    '}',
    'process.exit(0);',
    '',
  ].join('\n');
}

/**
 * Writes the executable `pnpm` and `gh` CLI shim scripts into `binDir` and initializes `ghPrsLogPath`.
 *
 * Marks both shims executable (`0o755`) so `local.command`, `local.streamCheck`, and `local.daemon`
 * execute against deterministic local subprocesses.
 *
 * @param {string} binDir       - Directory prepended to `PATH` for CLI shims.
 * @param {string} ghPrsLogPath - Path to the JSON file tracking `gh pr create` calls.
 *
 * @returns {Promise<void>} Resolves once `ghPrsLogPath`, `pnpm`, and `gh` shims are written.
 */
export async function writeIntegrationCliShims(
  binDir: string,
  ghPrsLogPath: string,
): Promise<void> {
  await mkdir(binDir, { recursive: true });
  await writeFile(ghPrsLogPath, '[]', 'utf8');
  await writeFile(path.join(binDir, 'pnpm'), PNPM_SHIM_SCRIPT, {
    encoding: 'utf8',
    mode: 0o755,
  });
  await writeFile(path.join(binDir, 'gh'), buildGhShimScript(ghPrsLogPath), {
    encoding: 'utf8',
    mode: 0o755,
  });
}
