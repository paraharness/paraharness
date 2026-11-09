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
 * Canonical 1-13 package ordering across Core, Essentials, and Vendor Adapters.
 */
const CANONICAL_PACKAGE_ORDER = [
  '@paraharness/core',
  '@paraharness/node',
  '@paraharness/git',
  '@paraharness/fs',
  '@paraharness/markdown',
  '@paraharness/sqlite',
  '@paraharness/postgres',
  '@paraharness/lockfile',
  '@paraharness/claude',
  '@paraharness/openai',
  '@paraharness/gemini',
  '@paraharness/github',
  '@paraharness/slack',
];

/**
 * High-signal member category ordering inside each package's API sidebar.
 */
const MEMBER_CATEGORY_ORDER = [
  'Variables',
  'Functions',
  'Classes',
  'Interfaces',
  'Type Aliases',
  'Enumerations',
];

/**
 * Returns the canonical sort rank for a package name (`@paraharness/<pkg>`).
 *
 * Places listed packages in exact `CANONICAL_PACKAGE_ORDER` sequence and any unlisted entries last.
 *
 * @param {string} packageName - Scoped package name such as `'@paraharness/core'`.
 *
 * @returns {number} Zero-based sort index.
 */
function getPackageOrderRank(packageName) {
  const idx = CANONICAL_PACKAGE_ORDER.indexOf(packageName);
  return idx === -1 ? CANONICAL_PACKAGE_ORDER.length : idx;
}

/**
 * Returns the canonical sort rank for a TypeDoc member category heading.
 *
 * Places `Variables` and `Functions` ahead of `Classes` and `Interfaces`.
 *
 * @param {string} categoryText - Sidebar category label such as `'Variables'` or `'Interfaces'`.
 *
 * @returns {number} Zero-based sort index.
 */
function getCategoryOrderRank(categoryText) {
  const idx = MEMBER_CATEGORY_ORDER.indexOf(categoryText);
  return idx === -1 ? MEMBER_CATEGORY_ORDER.length : idx;
}

/**
 * Normalizes a sidebar node recursively for clean VitePress URLs and canonical ordering.
 *
 * Strips `.md` suffixes from leaf links and sorts category groups by `MEMBER_CATEGORY_ORDER`.
 *
 * @param {object} node - Raw sidebar item emitted by `typedoc-vitepress-theme`.
 *
 * @returns {object} Normalized VitePress sidebar item.
 */
function normalizeSidebarNode(node) {
  const normalized = { ...node };
  if (typeof normalized.link === 'string') {
    normalized.link = normalized.link.replace(/\/index\.md$/, '/').replace(/\.md$/, '');
  }
  if (Array.isArray(normalized.items)) {
    normalized.collapsed = true;
    normalized.items = normalized.items
      .map((child) => normalizeSidebarNode(child))
      .sort((a, b) => getCategoryOrderRank(a.text) - getCategoryOrderRank(b.text));
  }
  return normalized;
}

/**
 * Post-processes `site/api/typedoc-sidebar.json` and `site/api/index.md` into the canonical 1-13 package order.
 *
 * Sorts package entries in `typedoc-sidebar.json` and reorders the package table rows in `site/api/index.md`.
 *
 * @returns {void}
 */
function postProcessApiDocsOrder() {
  const sidebarPath = path.join(SITE_DIR, 'api', 'typedoc-sidebar.json');
  const rawSidebar = JSON.parse(readFileSync(sidebarPath, 'utf8'));
  const sortedSidebar = rawSidebar
    .map((pkgNode) => normalizeSidebarNode(pkgNode))
    .sort((a, b) => getPackageOrderRank(a.text) - getPackageOrderRank(b.text));
  writeFileSync(sidebarPath, `${JSON.stringify(sortedSidebar, null, 2)}\n`, 'utf8');

  const apiIndexPath = path.join(SITE_DIR, 'api', 'index.md');
  const apiIndexMarkdown = readFileSync(apiIndexPath, 'utf8');
  const lines = apiIndexMarkdown.split('\n');
  const headerLines = [];
  const rowByPkg = new Map();
  const trailingLines = [];
  let inTableRows = false;

  for (const line of lines) {
    const match = line.match(/^\|\s*\[(@paraharness\/[a-z0-9-]+)\]/);
    if (match && match[1]) {
      inTableRows = true;
      rowByPkg.set(match[1], line);
    } else if (!inTableRows) {
      headerLines.push(line);
    } else {
      trailingLines.push(line);
    }
  }

  const orderedRows = CANONICAL_PACKAGE_ORDER.map((pkg) => rowByPkg.get(pkg)).filter(Boolean);
  const reorderedMarkdown = [...headerLines, ...orderedRows, ...trailingLines].join('\n');
  writeFileSync(apiIndexPath, reorderedMarkdown, 'utf8');
}

/**
 * Rewrites external GitHub Pages TypeDoc URLs and relative repository links into internal VitePress SPA routes.
 *
 * Converts legacy `/modules/_paraharness_<pkg>.html` links to `/api/@paraharness/<pkg>/` and resolves
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
      '/api/@paraharness/core/',
    )
    .replace(
      /https:\/\/paraharness\.github\.io\/paraharness\/modules\/_paraharness_([a-z0-9-]+)\.html/g,
      '/api/@paraharness/$1/',
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
    const targetPath = `/paraharness/api/@paraharness/${pkgName}/`;
    writeFileSync(
      path.join(modulesDir, `_paraharness_${pkgName}.html`),
      createRedirectHtml(targetPath, `@paraharness/${pkgName} API Reference`),
      'utf8',
    );
  }

  writeFileSync(
    path.join(modulesDir, '_paraharness_core.runtime.html'),
    createRedirectHtml(
      '/paraharness/api/@paraharness/core/',
      '@paraharness/core/runtime API Reference',
    ),
    'utf8',
  );
}

/**
 * Executes the complete Paraharness documentation build pipeline.
 *
 * Runs TypeDoc markdown generation, reorders the API index and sidebar into canonical 1-13 package order,
 * populates VitePress guide and package pages from repository READMEs, compiles the static VitePress SPA
 * into `docs-dist`, and writes legacy TypeDoc module HTML redirects.
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

  postProcessApiDocsOrder();
  const packageNames = generateGuideAndPackagePages();

  execFileSync(pnpmBin, ['exec', 'vitepress', 'build', 'site'], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  });

  writeLegacyModuleRedirects(packageNames);
}

buildDocs();
