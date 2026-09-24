// Report how many bytes the plugin keeps resident in every model request,
// versus what sits behind wiki_guide. Run: `node scripts/prompt-size.mjs`.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const bytes = (text) => Buffer.byteLength(text, 'utf8');

const { createPromptSource, observeWiki, GUIDE_TOPICS } = await import('../lib/prompt.js');
const prompt = createPromptSource();
const section = prompt.provider('/home/user/.dsh/wiki');
// The section is byte-stable: whatever the wiki looks like, these are the same
// bytes. The state line rides in the runtime-context snapshot instead, which
// the harness appends only when its text actually changes.
observeWiki(prompt.stats, 42, 3);
const state = prompt.stateProvider();

const playbooks = [];
for (const topic of GUIDE_TOPICS) {
  playbooks.push([topic, bytes((await readFile(join(root, 'prompts', `${topic}.md`), 'utf8')).trim())]);
}
const playbookTotal = playbooks.reduce((sum, [, size]) => sum + size, 0);
const v01Resident = bytes(section) - section.length + playbookTotal + 2 * (GUIDE_TOPICS.length - 1);

console.log('resident in every request (section, identical for every wiki state):');
console.log(`  section    : ${bytes(section)} bytes`);
console.log(`  + snapshot : ${bytes(state)} bytes (appended on change, not per request)`);
console.log('on demand via wiki_guide:');
for (const [topic, size] of playbooks) console.log(`  ${topic.padEnd(11)}: ${size} bytes`);
console.log(`  total      : ${playbookTotal} bytes`);
console.log(`\nvs v0.1 (all four playbooks inlined): ~${v01Resident} bytes resident -> ${Math.round((1 - bytes(section) / v01Resident) * 100)}% smaller`);
