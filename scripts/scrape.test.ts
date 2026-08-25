import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  HARVEST_EXPRESSION,
  isPrivateAddress,
  keepPreviousEnrichment,
  parseHarvest,
  resolvePublicDestination,
} from './scrape.ts';
import type { Scraped } from './store.ts';

const URL_ = 'https://www.compass.com/homedetails/424-28th-St-San-Francisco-CA-94131/1QUY9H_pid/';

const RESIDENCE = {
  '@type': 'SingleFamilyResidence',
  url: URL_,
  address: {
    '@type': 'PostalAddress',
    streetAddress: '424 28th St',
    addressLocality: 'Noe Valley',
    addressRegion: 'CA',
    // no postalCode — the shape that made a half-rendered page fatal
  },
  offers: { '@type': 'Offer', price: 3250000, availability: 'https://schema.org/InStock' },
};

const FULL_OG = {
  'og:title': '424 28th St, San Francisco, CA 94131 | MLS #426153785',
  'og:description':
    '424 28th St, San Francisco, CA 94131 is a single family home that will be listed for sale ' +
    'at $3,250,000. This is a 3-bed, 3-bath, 2,315 sqft property.',
  'og:image': 'https://www.compass.com/m/abc/origin.jpg',
};

test('scraping into an uninitialized folder costs nothing and says what to do', async () => {
  // The guard runs before anything is parsed, so a good payload still writes
  // nothing. Without it, readStore raised a bare ENOENT *after* the geocode and
  // a photo download that had already created photos/ and an orphaned image.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'property-hunt-uninit-'));
  const out = execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL('./scrape.ts', import.meta.url)),
      '--harvest',
      JSON.stringify({ jsonld: [JSON.stringify(RESIDENCE)], og: FULL_OG, settled: true }),
      URL_,
    ],
    { env: { ...process.env, PROPERTY_HUNT_DIR: dir }, encoding: 'utf8' },
  );

  const payload = JSON.parse(out.trim());
  assert.equal(payload.type, 'tool_error');
  assert.match(payload.error, /no store at/);
  assert.match(payload.error, /SKILL\.md/, 'points at the canonical init command rather than a cwd-relative one');
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing may be written before the store is known to exist');
});

test('a refresh keeps only the enrichment this run failed to produce', () => {
  const build = (lat: number | null, lng: number | null, photo: string | null) =>
    ({ lat, lng, photo }) as Scraped;
  // Photo carry-forward is filesystem-backed and has its own test below; this
  // matrix covers the coordinate contract, so an empty dir is the right input.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'property-hunt-coords-'));

  for (const { name, fresh, previous, kept, expected } of [
    {
      name: 'a transient geocoder failure keeps the last known coordinates',
      fresh: build(null, null, null),
      previous: build(37.745, -122.432, 'photos/x.jpg'),
      // Photo is absent from this dir, so it is correctly not carried — the
      // filesystem-backed case has its own test.
      kept: ['coordinates'],
      expected: [37.745, -122.432, null],
    },
    {
      name: 'a successful refresh still overwrites',
      fresh: build(9, 8, 'photos/new.jpg'),
      previous: build(1, 2, 'photos/old.jpg'),
      kept: [],
      expected: [9, 8, 'photos/new.jpg'],
    },
    {
      name: 'a new property has nothing to carry forward',
      fresh: build(null, null, null),
      previous: undefined,
      kept: [],
      expected: [null, null, null],
    },
  ]) {
    assert.deepEqual(keepPreviousEnrichment(fresh, previous, dir), kept, name);
    assert.deepEqual([fresh.lat, fresh.lng, fresh.photo], expected, name);
  }
});

// --- The image URL comes from the listing page, so it is attacker input ------

test('photo addresses are classified by routability, not by spelling', () => {
  for (const { expected, addresses } of [
    {
      expected: true,
      addresses: [
        '127.0.0.1', '127.1.2.3', '0.0.0.0', '10.0.0.5', '172.16.9.9', '172.31.255.1',
        '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1',
        '::1', '::', 'fc00::1', 'fd12::3', 'fe80::1', '[::1]',
        // Spellings the first version of this guard let through — one address
        // has many texts, so these are judged by value.
        '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:0:7f00:1', '64:ff9b::7f00:1',
        '::ffff:a00:1', 'fe90::1', 'feb0::1',
      ],
    },
    {
      expected: false,
      addresses: [
        '93.184.216.34', '8.8.8.8', '172.32.0.1', '169.253.0.1',
        '2606:2800:220:1::1', '2001:4860:4860::8888', '::ffff:8.8.8.8', '::ffff:808:808',
      ],
    },
  ]) {
    for (const address of addresses) {
      assert.equal(isPrivateAddress(address), expected, `${address} should be ${expected ? 'refused' : 'allowed'}`);
    }
  }
});

test('a hostname that resolves inward is refused, not just a literal IP', async () => {
  // The realistic payload is a *name* — "localhost", or an attacker domain
  // whose A record points at 127.0.0.1 — so the guard resolves rather than
  // pattern-matching the URL text.
  await assert.rejects(() => resolvePublicDestination('http://localhost/x.jpg'), /non-public address/);
  await assert.rejects(() => resolvePublicDestination('http://127.0.0.1:9222/x.jpg'), /non-public address/);
  await assert.rejects(() => resolvePublicDestination('file:///etc/passwd'), /refusing a file: image URL/);
});

test('a redirect target is vetted against the same rule as the first hop', async () => {
  await assert.rejects(
    () => resolvePublicDestination('/internal', new URL('http://localhost/start')),
    /non-public address/,
  );
});

test('the vetted address is returned so the caller can pin to it', async () => {
  // Returning the address is what closes the rebinding window: validating a
  // name and letting the client resolve it again is two lookups, and the
  // attacker controls what the second one answers.
  const resolved = await resolvePublicDestination('http://93.184.216.34/x.jpg');
  assert.equal(resolved.address, '93.184.216.34');
  assert.equal(resolved.family, 4);
  assert.equal(resolved.url.hostname, '93.184.216.34');
});

test('a carried-forward photo must still exist on disk', () => {
  // Caught live: the download broke, the carry-forward kept the old path, and
  // the record pointed at a file that was gone — the map renders that as a
  // broken image, which is worse than the honest plain marker.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'property-hunt-photo-'));
  fs.mkdirSync(path.join(dir, 'photos'));
  const fresh = { lat: 1, lng: 2, photo: null } as unknown as Scraped;
  const previous = { lat: 1, lng: 2, photo: 'photos/gone.jpg' } as Scraped;

  assert.deepEqual(keepPreviousEnrichment(fresh, previous, dir), [], 'nothing to carry when the file is gone');
  assert.equal(fresh.photo, null, 'better a plain marker than a broken image');

  fs.writeFileSync(path.join(dir, 'photos', 'gone.jpg'), 'bytes');
  const second = { lat: 1, lng: 2, photo: null } as unknown as Scraped;
  assert.deepEqual(keepPreviousEnrichment(second, previous, dir), ['photo']);
  assert.equal(second.photo, 'photos/gone.jpg');
});

// --- the latch-backed harvest path -----------------------------------------

test('the harvest expression reads the same two surfaces the store needs', () => {
  // Pinned as strings because SKILL.md and the howto page both carry this
  // expression verbatim; a silent edit here desynchronises three copies.
  assert.match(HARVEST_EXPRESSION, /script\[type="application\/ld\+json"\]/);
  assert.match(HARVEST_EXPRESSION, /meta\[property\^="og:"\], meta\[name\^="twitter:"\]/);
  assert.match(HARVEST_EXPRESSION, /10000/, 'in-page deadline, inside latch 15s call budget');
  assert.match(HARVEST_EXPRESSION, /750/, 'poll interval, same as the loop this replaces');
  assert.match(HARVEST_EXPRESSION, /settled/, 'reports whether it returned by predicate or by deadline');
  assert.doesNotMatch(HARVEST_EXPRESSION, /\n/, 'travels as one JSON string field');
});

test('a malformed json-ld block does not lose the listing', () => {
  const { page } = parseHarvest(
    JSON.stringify({ jsonld: ['{not json', JSON.stringify(RESIDENCE)], og: FULL_OG, settled: true }),
    URL_,
  );
  assert.equal(page.url, URL_);
  assert.equal(page.jsonld.length, 1, 'the parseable block survives its broken neighbour');
  assert.equal(page.og['og:title'], FULL_OG['og:title']);
});

test('parseHarvest reports whether the page settled or timed out', () => {
  const base = { jsonld: [], og: {} };
  assert.equal(parseHarvest(JSON.stringify({ ...base, settled: true }), URL_).settled, true);
  assert.equal(parseHarvest(JSON.stringify({ ...base, settled: false }), URL_).settled, false);
  // An older payload with no flag must not silently read as "fully rendered" —
  // that is the reading that would suppress a retry the page still needs.
  assert.equal(parseHarvest(JSON.stringify(base), URL_).settled, false, 'absent means not settled');
});

function initStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'property-hunt-harvest-'));
  execFileSync(process.execPath, [fileURLToPath(new URL('./properties.ts', import.meta.url)), 'init'], {
    env: { ...process.env, PROPERTY_HUNT_DIR: dir },
    encoding: 'utf8',
  });
  return dir;
}

function harvestInto(dir: string, payload: unknown, url: string = URL_): string {
  return execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL('./scrape.ts', import.meta.url)),
      '--harvest',
      typeof payload === 'string' ? payload : JSON.stringify(payload),
      url,
    ],
    { env: { ...process.env, PROPERTY_HUNT_DIR: dir }, encoding: 'utf8' },
  );
}

test('--harvest saves a listing without touching a browser', () => {
  const dir = initStore();
  const out = harvestInto(dir, {
    jsonld: [JSON.stringify(RESIDENCE)],
    og: FULL_OG,
    settled: true,
  });

  assert.match(out, /^added /, 'prints the same verb the browser path printed');
  const store = fs.readFileSync(path.join(dir, 'data.js'), 'utf8');
  assert.match(store, /424 28th St/);
  assert.match(store, /"zip": "94131"/, 'the zip came from og:title, as it does in production');
});

test('a page that had not finished rendering is retryable, and writes nothing', () => {
  const dir = initStore();
  const before = fs.readFileSync(path.join(dir, 'data.js'), 'utf8');

  // The exact shape the old in-process loop retried and then succeeded on:
  // JSON-LD mounted without a postalCode, og:title not yet there. The eval hit
  // its deadline rather than settling, which is what makes it worth another go.
  const payload = JSON.parse(
    harvestInto(dir, { jsonld: [JSON.stringify(RESIDENCE)], og: {}, settled: false }).trim(),
  );

  assert.equal(payload.type, 'tool_error');
  assert.equal(payload.retryable, true, 'the eval timed out mid-render — one more poll is the fix');
  assert.match(payload.error, /zip is required/, 'names the actual blocker');
  assert.equal(
    fs.readFileSync(path.join(dir, 'data.js'), 'utf8'),
    before,
    'a failed harvest leaves the store byte-identical',
  );
});

test('a settled page missing a required field is not retryable, and says to try another site', () => {
  const dir = initStore();
  // Both surfaces mounted inside the deadline, and the address still is not
  // there: polling this same page again returns this same payload forever.
  const payload = JSON.parse(
    harvestInto(dir, {
      jsonld: [],
      og: { 'og:title': 'Listings near you', 'og:description': 'Browse homes for sale' },
      settled: true,
    }).trim(),
  );

  assert.equal(payload.type, 'tool_error');
  assert.ok(!payload.retryable, 'polling a settled page again cannot produce an address');
  assert.match(payload.error, /another listing site/, 'offers the remedy that can actually work');
});

test('--harvest rejects a payload that is not the two surfaces', () => {
  const dir = initStore();
  for (const bad of ['not json at all', '{"og":{}}', '{"jsonld":"a string","og":{}}']) {
    const payload = JSON.parse(harvestInto(dir, bad).trim());
    assert.equal(payload.type, 'tool_error', `rejected: ${bad}`);
    assert.ok(!payload.retryable, 'a malformed payload is the caller to fix, not the page');
  }
});

test('--harvest refuses a url that is not one', () => {
  const dir = initStore();
  const payload = JSON.parse(
    harvestInto(dir, { jsonld: [], og: {}, settled: true }, 'not-a-url').trim(),
  );
  assert.equal(payload.type, 'tool_error');
  assert.match(payload.error, /--harvest/, 'the usage line names the mode actually being used');
});
