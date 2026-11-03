import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export default {
  root: here,
  test: {
    include: ['*.fixture.mjs'],
    reporters: [join(here, '..', '..', '..', 'compact-vitest.mjs')],
  },
};
