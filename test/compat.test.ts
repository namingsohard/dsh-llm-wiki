import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NUDGE_SOURCE_KIND } from '../src/hooks/wiki-nudge.js';

/**
 * The host-compatibility contract.
 *
 * `dsh-app-boot` refuses to load a plugin whose `@deepseek-ai/dsh*` peer
 * ranges do not admit the running harness version — the bundle is skipped with
 * "Plugin <name> is incompatible with dsh <version>" (and the Loader disables
 * the row) — so `package.json` is load-bearing, not documentation. This suite
 * is the guard rail for that manifest: it re-implements the host's rule
 * (exact-version `||` lists, prereleases included) against the releases we
 * claim to serve, so a version bump that forgets the manifest fails here
 * instead of silently disabling the plugin in the field.
 *
 * It also pins the two manifest shapes the loaders read (`dsh.bundle.patch`,
 * `dsh.client` + `exports['./client']`) and the one message shape the session
 * format tightened in 0.1.7.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  main: string;
  files: string[];
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  dsh: { bundle: { patch: string }; client: { platform: string; inject: string[] } };
  exports: Record<string, unknown>;
};

/**
 * Published harness releases this plugin claims to serve, oldest first — every
 * `@deepseek-ai/dsh-*` package is versioned with the harness, so one list covers
 * the whole train. Extend it when a new host ships and the code is checked
 * against it; never widen it to an open range, which would claim hosts nobody
 * has tested against.
 */
export const SUPPORTED_HOSTS: readonly string[] = [
  '0.1.5-rc.1',
  '0.1.5-rc.2',
  '0.1.5-rc.3',
  '0.1.6-alpha.1',
  '0.1.6-alpha.2',
  '0.1.7-alpha.1',
  '0.1.7-alpha.2',
  '0.1.7-rc.1',
  '0.1.7-rc.2',
];

/** The peers the host gate inspects: `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*`. */
const gatedPeers = Object.entries(manifest.peerDependencies).filter(
  ([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'),
);

/**
 * `semver.satisfies(runtimeVersion, range, { includePrerelease: true })` for the
 * only range form this manifest uses: an `||`-list of exact versions. Anything
 * else fails loudly here rather than quietly widening the claim.
 */
function admits(range: string, version: string): boolean {
  const tokens = range.split('||').map((token) => token.trim());
  for (const token of tokens) {
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(token)) {
      throw new Error(`peer range must be an ||-list of exact versions, got ${JSON.stringify(token)}`);
    }
  }
  return tokens.includes(version);
}

describe('host compatibility contract', () => {
  it('declares the peers the host gate reads', () => {
    expect(gatedPeers.map(([name]) => name).sort()).toEqual([
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-tools',
    ]);
  });

  for (const host of SUPPORTED_HOSTS) {
    it(`is loadable on dsh ${host}`, () => {
      for (const [name, range] of gatedPeers) {
        expect(admits(range, host), `${name} must admit ${host}`).toBe(true);
      }
    });
  }

  it('does not claim hosts nobody has run it on', () => {
    for (const future of ['0.1.4-rc.1', '0.1.8-alpha.1', '0.2.0-alpha.1']) {
      for (const [name, range] of gatedPeers) {
        expect(admits(range, future), `${name} must NOT claim ${future}`).toBe(false);
      }
    }
  });

  it('ships one schemastery line, matching what the newest supported host carries', () => {
    // Two copies of Schemastery in one tree declare the same global interface
    // and break declaration emit; the 0.1.7 host chain pins ~3.18.4.
    expect(manifest.dependencies['@deepseek-ai/schemastery']).toBe('^3.18.4');
  });
});

describe('loader contract', () => {
  it('points dsh.bundle.patch at a real patch file', () => {
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml');
    expect(existsSync(join(root, 'cordis.patch.yml'))).toBe(true);
  });

  it('declares the web client half the way dsh-client-modules reads it', () => {
    expect(manifest.dsh.client.platform).toBe('web');
    // Services the client plugin injects must exist on the host, or the client
    // composition fails at activation — these two are the sidebar seats.
    expect(manifest.dsh.client.inject).toEqual([
      '@deepseek-ai/dsh-client-ui-sidebar-right',
      '@deepseek-ai/dsh-client-ui-session',
    ]);
    expect(manifest.exports['./client']).toBe('./lib/client.js');
  });

  it('exposes the built entry DSH loads', () => {
    expect(manifest.main).toBe('./lib/index.js');
    expect(manifest.files).toContain('lib');
  });
});

describe('session message attribution', () => {
  it('uses a producer-owned source kind (session format v4, dsh 0.1.7+)', () => {
    expect(NUDGE_SOURCE_KIND).toBe('plugin:dsh-llm-wiki');
    expect(NUDGE_SOURCE_KIND).not.toBe('plugin');
  });

  it('leaves no retired `{ kind: \'plugin\' }` wrapper in the shipped code', () => {
    // v3→v4 migration rewrites the wrapper; writing it on a v4 host is a hard
    // rejection on the session append path. Comments are stripped first — the
    // docs are allowed to name the retired spelling they are warning about.
    const stripComments = (text: string): string => text.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/[^\n]*/g, '');
    for (const file of ['src/hooks/wiki-nudge.ts', 'client/wiki-client.js']) {
      expect(stripComments(readFileSync(join(root, file), 'utf8'))).not.toMatch(/kind:\s*'plugin'/);
    }
  });
});
