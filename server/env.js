// Loads .env before any other module reads process.env (imported first by index.js). Real environment
// variables — e.g. hosting secrets — always win over the file.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(file)) {
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[2] !== '' && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}
