import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Absolute path to the repository workspace root directory.
 */
const ROOT_DIR = path.resolve(import.meta.dirname, '..');

/**
 * Absolute path to the VitePress documentation source directory.
 */
const SITE_DIR = path.join(ROOT_DIR, 'site');

/**
 * Absolute path to the built static documentation output directory.
 */
const DOCS_DIST_DIR = path.join(ROOT_DIR, 'docs-dist');

/**
 * Rewrites external GitHub Pages TypeDoc URLs and relative repository links into internal VitePress SPA routes.
 *
 * Converts legacy `/modules/_paraharness_<pkg>.html` links to `/api/@paraharness/<pkg>` and resolves
 * relative `./LICENSE` links to the canonical GitHub repository license URL so VitePress link validation succeeds.
 *
 * @param {string} markdown - Raw README markdown content.
 *
 * @returns {string} Transformed markdown with internal VitePress SPA links.
 */
function rewriteMarkdownLinksForSite(markdown) {
  return markdown
    .replace(
      /https:\/\/paraharness\.github\.io\/paraharness\/modules\/_paraharness_core\.runtime\.html/g,
      '/api/@paraharness/core',
    )
    .replace(
      /https:\/\/paraharness\.github\.io\/paraharness\/modules\/_paraharness_([a-z0-9-]+)\.html/g,
      '/api/@paraharness/$1',
    )
    .replace(/https:\/\/paraharness\.github\.io\/paraharness\//g, '/')
    .replace(
      /\]\(\.\/LICENSE\)/g,
      '](https://github.com/paraharness/paraharness/blob/main/LICENSE)',
    );
}

/**
 * Generates `site/guide/getting-started.md` and `site/packages/<pkg>.md` from repository README files.
 *
 * Reads the root `README.md` and each workspace package `README.md` under `packages/*`, rewrites links
 * for in-app SPA navigation, and writes the resulting pages into `site/guide/` and `site/packages/`.
 *
 * @returns {string[]} Sorted list of workspace package directory names.
 */
function generateGuideAndPackagePages() {
  const guideDir = path.join(SITE_DIR, 'guide');
  const sitePackagesDir = path.join(SITE_DIR, 'packages');
  mkdirSync(guideDir, { recursive: true });
  mkdirSync(sitePackagesDir, { recursive: true });

  const rootReadme = readFileSync(path.join(ROOT_DIR, 'README.md'), 'utf8');
  writeFileSync(
    path.join(guideDir, 'getting-started.md'),
    rewriteMarkdownLinksForSite(rootReadme),
    'utf8',
  );

  const packagesRoot = path.join(ROOT_DIR, 'packages');
  const packageNames = readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const pkgName of packageNames) {
    const pkgReadmePath = path.join(packagesRoot, pkgName, 'README.md');
    const pkgReadme = readFileSync(pkgReadmePath, 'utf8');
    writeFileSync(
      path.join(sitePackagesDir, `${pkgName}.md`),
      rewriteMarkdownLinksForSite(pkgReadme),
      'utf8',
    );
  }

  return packageNames;
}

/**
 * Builds an HTML redirect document that forwards legacy TypeDoc module URLs to VitePress API routes.
 *
 * Emits both `<meta http-equiv="refresh">` and `location.replace()` preserving any URL hash fragment.
 *
 * @param {string} targetPath - Target site-absolute path starting with `/paraharness/api/...`.
 * @param {string} label      - Human-readable package label for the fallback link.
 *
 * @returns {string} Complete HTML redirect document string.
 */
function createRedirectHtml(targetPath, label) {
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    `  <title>Redirecting to ${label}</title>`,
    `  <meta http-equiv="refresh" content="0; url=${targetPath}">`,
    `  <link rel="canonical" href="https://paraharness.github.io${targetPath}">`,
    `  <script>location.replace(${JSON.stringify(targetPath)} + location.hash);</script>`,
    '</head>',
    '<body>',
    `  <p>Redirecting to <a href="${targetPath}">${label}</a>...</p>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * Writes legacy TypeDoc redirect pages into `docs-dist/modules/` for backward compatibility with published npm metadata.
 *
 * Generates `docs-dist/modules/_paraharness_<pkg>.html` for every package and `_paraharness_core.runtime.html`.
 *
 * @param {string[]} packageNames - List of workspace package directory names.
 *
 * @returns {void}
 */
function writeLegacyModuleRedirects(packageNames) {
  writeFileSync(path.join(DOCS_DIST_DIR, '.nojekyll'), '', 'utf8');
  const modulesDir = path.join(DOCS_DIST_DIR, 'modules');
  mkdirSync(modulesDir, { recursive: true });

  for (const pkgName of packageNames) {
    const targetPath = `/paraharness/api/@paraharness/${pkgName}`;
    writeFileSync(
      path.join(modulesDir, `_paraharness_${pkgName}.html`),
      createRedirectHtml(targetPath, `@paraharness/${pkgName} API Reference`),
      'utf8',
    );
  }

  writeFileSync(
    path.join(modulesDir, '_paraharness_core.runtime.html'),
    createRedirectHtml(
      '/paraharness/api/@paraharness/core',
      '@paraharness/core/runtime API Reference',
    ),
    'utf8',
  );
}

/**
 * Executes the complete Paraharness documentation build pipeline.
 *
 * Runs TypeDoc markdown generation, populates VitePress guide and package pages from repository READMEs,
 * compiles the static VitePress SPA into `docs-dist`, and writes legacy TypeDoc module HTML redirects.
 *
 * @returns {void}
 */
function buildDocs() {
  const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  rmSync(path.join(SITE_DIR, 'api'), { recursive: true, force: true });
  rmSync(DOCS_DIST_DIR, { recursive: true, force: true });

  execFileSync(pnpmBin, ['exec', 'typedoc'], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  });

  const packageNames = generateGuideAndPackagePages();

  execFileSync(pnpmBin, ['exec', 'vitepress', 'build', 'site'], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  });

  writeLegacyModuleRedirects(packageNames);
}

buildDocs();
