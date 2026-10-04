/*
 * Copies the hand-written browser bundle into the published tree.
 *
 * `client/wiki-client.js` is authored directly in the lazy-CJS factory format
 * the DSH client module system consumes (see the header comment there); the
 * `dsh.client` manifest points at `lib/client.js`, which tsc never produces.
 * This script is the build's copy step and its syntax gate: a bundle that
 * fails `node --check` never reaches lib/, because a shipped client bundle
 * with a parse error fails the whole web composition's module scan.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const source = join(repo, 'client', 'wiki-client.js');
const target = join(repo, 'lib', 'client.js');

const check = spawnSync(process.execPath, ['--check', source], { stdio: 'inherit' });
if (check.status !== 0) {
  console.error('build-client: client/wiki-client.js has a syntax error');
  process.exit(check.status ?? 1);
}

const text = readFileSync(source, 'utf8');
for (const needle of ['window.__ModuleLoader__.load', 'id: "dsh-llm-wiki"']) {
  if (!text.includes(needle)) {
    console.error(`build-client: client/wiki-client.js must contain ${needle}`);
    process.exit(1);
  }
}

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.log(`build-client: client/wiki-client.js -> lib/client.js (${String(text.length)} chars)`);
