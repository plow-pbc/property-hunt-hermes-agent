#!/usr/bin/env node
// Dev install: push this working copy into ~/Plow/skills/ without going through
// ClawHub. Mirrors the plow repo's `just sync-team-skills` recipe rather than
// inventing a second mechanism.
//
// Not shipped to users — they install from the marketplace.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SLUG = 'property-hunt';
const BUNDLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_ID = process.env.PLOW_BUNDLE_ID ?? 'co.plow.app';
const APP_SUPPORT = path.join(os.homedir(), 'Library', 'Application Support', BUNDLE_ID);

// plow-local-token gates the marketplace mutation routes. It is a different
// bearer from plow-api-token.
const TOKEN_PATH = path.join(APP_SUPPORT, 'agent-runtime', 'secrets', 'plow-local-token');

/**
 * plowd's HTTP port is assigned dynamically. 18788 is the in-VM agent->plowd
 * callback port, not this one — hardcoding it points at the wrong daemon.
 */
function resolvePlowdPort(): number {
  const devPortFile = path.join(APP_SUPPORT, 'dev-plowd-port');
  if (fs.existsSync(devPortFile)) {
    const port = Number(fs.readFileSync(devPortFile, 'utf8').trim());
    if (Number.isInteger(port) && port > 0) return port;
  }

  // pgrep exits 1 when nothing matches, which execFileSync turns into a throw —
  // so without this the intended "start Plow.app" message never surfaces.
  const found = spawnSync('pgrep', ['-f', 'python3 -m uvicorn plowd\\.main'], { encoding: 'utf8' });
  const pid = (found.stdout ?? '').split('\n').filter(Boolean)[0];
  if (!pid) throw new Error(`plowd is not running for '${BUNDLE_ID}' — start Plow.app first`);

  const listening = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', pid], {
    encoding: 'utf8',
  });
  for (const line of listening.split('\n').slice(1)) {
    const address = line.split(/\s+/)[8];
    if (address) {
      const port = Number(address.split(':').pop());
      if (Number.isInteger(port) && port > 0) return port;
    }
  }
  throw new Error(`could not resolve plowd's HTTP port from pid ${pid}`);
}

async function main(): Promise<void> {
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(`no plow-local-token under ${APP_SUPPORT} — is Plow.app installed for '${BUNDLE_ID}'?`);
  }
  if (!fs.existsSync(path.join(BUNDLE_ROOT, 'SKILL.md'))) {
    throw new Error(`no SKILL.md at ${BUNDLE_ROOT} — a bundle without one will not install`);
  }

  const port = resolvePlowdPort();

  // The endpoint takes a tarball rather than a host path on purpose: it is
  // reachable from the agent VM, so accepting paths would let a prompt-injected
  // agent read arbitrary host files through the staging copy.
  const tar = execFileSync(
    'tar',
    [
      'czf', '-',
      '-C', path.dirname(BUNDLE_ROOT),
      '--exclude', '.git',
      '--exclude', '.DS_Store',
      // Same file .clawhubignore keeps out of the published bundle, so a dev
      // install rehearses what users actually receive.
      '--exclude', 'install-local.ts',
      path.basename(BUNDLE_ROOT),
    ],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );

  // Read the token in-process so it never appears in `ps` while the upload runs.
  const token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:${port}/marketplace/api/install-local-bundles`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/gzip' },
    body: new Uint8Array(tar),
  });

  const body = await response.text();
  if (!response.ok) throw new Error(`install failed (HTTP ${response.status}): ${body}`);

  const installed = path.join(os.homedir(), 'Plow', 'skills', SLUG, 'SKILL.md');
  if (!fs.existsSync(installed)) {
    throw new Error(`plowd reported success but ${installed} is missing`);
  }
  process.stdout.write(`installed ${SLUG} (${(tar.length / 1024).toFixed(0)} KB) -> ~/Plow/skills/${SLUG}\n`);
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
