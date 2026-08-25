import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { envelope, takeRequest } from './properties.ts';
import { coerceScraped, emptyStoreText, loadStore, serializeStore, upsertScraped } from './store.ts';

const CLI = fileURLToPath(new URL('./properties.ts', import.meta.url));

const LISTING = {
  address: '424 28th Street',
  city: 'San Francisco',
  state: 'CA',
  zip: '94131',
  lat: 37.7451548,
  lng: -122.4320644,
  price: 3250000,
  beds: 3,
  baths: 3,
  sqft: 2315,
  property_type: 'SingleFamilyResidence',
  listing_status: 'active',
  listing_url: 'https://www.compass.com/homedetails/424-28th-St-San-Francisco-CA-94131/1QUY9H_pid/',
};

/** A store containing one property, as text — what the agent would pass. */
function store(over: Record<string, unknown> = {}): string {
  return serializeStore(upsertScraped(loadStore(emptyStoreText()), coerceScraped({ ...LISTING, ...over })));
}

/**
 * Run the CLI the way the agent does: a real request file on disk.
 *
 * Executing it matters. A previous version of this suite asserted only that
 * the flag was spelled right, and passed while every file-backed run failed —
 * readFileSync without an encoding returns a Buffer, which has no .trim().
 */
function run(req: Record<string, unknown>): { out: string; err: string; code: number } {
  const dir = mkdtempSync(join(tmpdir(), 'property-hunt-req-'));
  const path = join(dir, 'request.json');
  writeFileSync(path, JSON.stringify(req));
  const r = spawnSync(process.execPath, [CLI, '--request', path], { encoding: 'utf8' });
  return { out: r.stdout, err: r.stderr, code: r.status ?? 0 };
}

const ID = '424-28th-st-94131-ca';

test('the request file carries everything, and a missing store is fatal', () => {
  const req = takeRequest(['--request', '/x'], () => JSON.stringify({ verb: 'set', store: 'CONTENTS' }));
  assert.equal(req.store, 'CONTENTS');
  assert.equal(req.verb, 'set');
  assert.throws(() => takeRequest(['--request', '/x'], () => '{"verb":"list"}'), /store/);
  assert.throws(() => takeRequest([]), /--request/);
});

test('an envelope omits what there is nothing to do about', () => {
  // Absence is the signal the agent branches on, so an empty array or a null
  // would each be a second way of saying nothing — and one it might act on.
  const parsed = JSON.parse(envelope({ store: 'x', id: 'a', verb: 'updated' }));
  assert.deepEqual(Object.keys(parsed).sort(), ['id', 'store', 'verb']);
});

test('set prints the new store and touches no disk', () => {
  const { out } = run({ verb: 'set', id: ID, field: 'notes', value: "needs a roof, don't love the kitchen", store: store() });
  const env = JSON.parse(out);
  assert.equal(env.verb, 'updated');
  assert.equal(env.id, ID);
  const rows = loadStore(env.store);
  assert.equal(rows[0].mine.notes, "needs a roof, don't love the kitchen", 'the apostrophe survives argv');
  assert.equal(rows[0].scraped.address, '424 28th Street', 'scraped is untouched by a mine edit');
  assert.equal(env.fetch, undefined);
});

test('multi-word notes arrive whole', () => {
  const env = JSON.parse(run({ verb: 'set', id: ID, field: 'notes', value: 'needs a new roof', store: store() }).out);
  assert.equal(loadStore(env.store)[0].mine.notes, 'needs a new roof');
});

test('rm prints the new store and names the photo rather than deleting it', () => {
  const env = JSON.parse(run({ verb: 'rm', id: ID, store: store({ photo: 'photos/x.jpg' }) }).out);
  assert.equal(env.verb, 'removed');
  assert.deepEqual(loadStore(env.store), []);
  // Named, not unlinked: nothing in this process can reach the Mac.
  assert.deepEqual(env.remove, ['photos/x.jpg']);
});

test('rm of a property with no photo asks for no deletion', () => {
  assert.equal(JSON.parse(run({ verb: 'rm', id: ID, store: store() }).out).remove, undefined);
});

test('list and get read the store they are handed', () => {
  assert.match(run({ verb: 'list', store: store() }).out, /424 28th/);
  assert.equal(JSON.parse(run({ verb: 'get', id: ID, store: store() }).out).id, ID);
  assert.equal(JSON.parse(run({ verb: 'list', json: true, store: store() }).out).length, 1);
  assert.match(run({ verb: 'list', store: emptyStoreText() }).out, /no properties yet/);
});

test('every verb refuses to run without a store', () => {
  // Defaulting to an empty store would print a valid-looking envelope whose
  // write discards every property the operator has.
  for (const verb of ['list', 'get', 'set', 'rm']) {
    const { out, err, code } = run({ verb, id: ID, field: 'notes', value: 'x' } as never);
    assert.notEqual(code, 0, `${verb} must exit non-zero`);
    assert.match(err, /store/, `${verb} must say what is missing`);
    assert.doesNotMatch(out, /"store"/, `${verb} must print no envelope`);
  }
});

test('shell metacharacters in a note survive intact', () => {
  // The reason the request file exists. None of this is ever a shell word.
  const nasty = `'; touch /tmp/pwned; echo '$(whoami)` + '`id`' + ' "quoted" \\backslash';
  const env = JSON.parse(run({ verb: 'set', id: ID, field: 'notes', value: nasty, store: store() }).out);
  assert.equal(loadStore(env.store)[0].mine.notes, nasty);
});

test('a blank --store is refused rather than read as an empty store', () => {
  const { err, code } = run({ verb: 'list', store: '' });
  assert.notEqual(code, 0);
  assert.match(err, /empty/i);
});

test('init and where are gone with the filesystem', () => {
  for (const verb of ['init', 'where']) {
    assert.notEqual(run({ verb, store: store() }).code, 0, `${verb} is no longer a verb`);
  }
});

test('an unknown id lists the ids that do exist', () => {
  const { err } = run({ verb: 'set', id: 'no-such-house', field: 'rating', value: '4', store: store() });
  assert.match(err, /no property with id/);
  assert.match(err, new RegExp(ID));
});
