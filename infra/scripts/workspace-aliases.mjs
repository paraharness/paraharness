import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const PACKAGES = 'packages';
const BUILT = /^\.\/dist\//;
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const entries = (manifest) => {
  if (manifest.exports) return Object.entries(manifest.exports).map(([subpath, target]) => [subpath, typeof target === 'string' ? target : target.default]);
  return manifest.main ? [['.', manifest.main]] : [];
};

const sourceOf = (dir, built) => {
  const path = join(dir, built.replace(BUILT, 'src/'));
  const candidates = path.endsWith('.js') ? SOURCE_EXTENSIONS.map((extension) => path.replace(/\.js$/, extension)) : [path];
  return candidates.find((candidate) => existsSync(candidate));
};

export const workspaceAliases = (root = REPO) =>
  readdirSync(join(root, PACKAGES)).flatMap((name) => {
    const dir = join(root, PACKAGES, name);
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) return [];
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return entries(manifest)
      .filter(([subpath, built]) => !subpath.includes('*') && typeof built === 'string' && BUILT.test(built))
      .flatMap(([subpath, built]) => {
        const source = sourceOf(dir, built);
        return source ? [{ find: new RegExp(`^${escape(`${manifest.name}${subpath.slice(1)}`)}$`), replacement: source }] : [];
      });
  });
