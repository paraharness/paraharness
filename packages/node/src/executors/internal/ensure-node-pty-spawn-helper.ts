import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Ensures the `node-pty` native `spawn-helper` binary carries executable permissions (`0o755`) on POSIX hosts.
 *
 * Prevents `posix_spawnp failed` errors on macOS when package managers extract prebuilt `spawn-helper`
 * binaries without the `+x` execute bit set.
 */
export function ensureNodePtySpawnHelperExecutable(): void {
  try {
    const req = createRequire(import.meta.url);
    const ptyEntry = req.resolve('node-pty');
    const ptyRoot = path.resolve(path.dirname(ptyEntry), '..');
    const candidates = [
      path.join(ptyRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
      path.join(ptyRoot, 'build', 'Release', 'spawn-helper'),
      path.join(ptyRoot, 'build', 'Debug', 'spawn-helper'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        fs.chmodSync(candidate, 0o755);
      }
    }
  } catch {
    return;
  }
}
