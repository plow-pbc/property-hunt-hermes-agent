import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  HARVEST_EXPRESSION,
  isPrivateAddress,
  keepPreviousEnrichment,
  parseHarvest,
  photoDirective,
  resolvePublicDestination,
} from './scrape.ts';
import { emptyStoreText, loadStore, serializeStore } from './store.ts';
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

test('a blank store is refused before anything is parsed', () => {
  // The guard the old "no store at <dir>" check was: the caller handed us
  // nothing to work from. Failing here rather than later is what kept a
  // geocode and a photo download from running against a store that was not
  // there — now it keeps an envelope from proposing a write that would
  // discard every property.
  // scrape.ts reports a failure as a tool RESULT, not a crashed command — the
  // agent reads it and speaks. So the contract is the payload, not the exit
  // code: a tool_error and no envelope, meaning nothing to write back.
  const good = JSON.stringify({ jsonld: [JSON.stringify(RESIDENCE)], og: FULL_OG, settled: true });
  const payload = JSON.parse(harvest(good, URL_, '').out.trim());
  assert.equal(payload.type, 'tool_error');
  assert.match(payload.error, /empty/i);
  assert.equal(payload.store, undefined, 'nothing to write back');
});

test('scrape refuses to run without --store at all', () => {
  const good = JSON.stringify({ jsonld: [JSON.stringify(RESIDENCE)], og: FULL_OG, settled: true });
  const r = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./scrape.ts', import.meta.url)), '--harvest', good, URL_],
    { encoding: 'utf8' },
  );
  const payload = JSON.parse(r.stdout.trim());
  assert.equal(payload.type, 'tool_error');
  assert.match(payload.error, /--store/);
  assert.equal(payload.store, undefined);
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
    assert.deepEqual(keepPreviousEnrichment(fresh, previous, false), kept, name);
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

test('a carried-forward photo depends on the caller saying it is there', () => {
  // Caught live: the download broke, the carry-forward kept the old path, and
  // the record pointed at a file that was gone — the map renders that as a
  // broken image, which is worse than the honest plain marker.
  //
  // Whether the file is there is the agent's knowledge now: it holds the Mac.
  // Absent means no, which costs a re-fetch rather than a broken pin.
  const previous = { lat: 1, lng: 2, photo: 'photos/gone.jpg' } as Scraped;

  const gone = { lat: 1, lng: 2, photo: null } as unknown as Scraped;
  assert.deepEqual(keepPreviousEnrichment(gone, previous, false), [], 'nothing carried when it is not there');
  assert.equal(gone.photo, null, 'better a plain marker than a broken image');

  const present = { lat: 1, lng: 2, photo: null } as unknown as Scraped;
  assert.deepEqual(keepPreviousEnrichment(present, previous, true), ['photo']);
  assert.equal(present.photo, 'photos/gone.jpg');
});

// --- the latch-backed harvest path -----------------------------------------

test('the harvest expression reads the surfaces extractScraped consumes', () => {
  // Only what running it cannot prove: the selectors have to match what
  // extract.ts reads, and the deadline is shadowed by the run test below, so
  // a change to it would otherwise pass unnoticed.
  assert.match(HARVEST_EXPRESSION, /script\[type="application\/ld\+json"\]/);
  assert.match(HARVEST_EXPRESSION, /meta\[property\^="og:"\], meta\[name\^="twitter:"\]/);
  assert.match(HARVEST_EXPRESSION, /Date\.now\(\) \+ 10000/, 'inside latch 15s call budget');
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

/** Run the transform the way the agent does: store in, envelope out. */
function harvest(payload: unknown, url: string = URL_, store: string = emptyStoreText(), extra: string[] = []) {
  const r = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./scrape.ts', import.meta.url)),
      '--harvest',
      typeof payload === 'string' ? payload : JSON.stringify(payload),
      url,
      '--store',
      store,
      ...extra,
    ],
    { encoding: 'utf8' },
  );
  return { out: r.stdout, err: r.stderr, code: r.status ?? 0 };
}

test('--harvest saves a listing without touching a browser', () => {
  const env = JSON.parse(harvest({ jsonld: [JSON.stringify(RESIDENCE)], og: FULL_OG, settled: true }).out);

  assert.equal(env.verb, 'added');
  assert.equal(env.id, '424-28th-st-94131-ca');
  const rows = loadStore(env.store);
  assert.equal(rows[0].scraped.address, '424 28th St');
  assert.equal(rows[0].scraped.zip, '94131', 'the zip came from og:title, as it does in production');
});

test('whether a failure is worth retrying is decided by how the poll exited', () => {
  // A missing field raises the identical message whether the page is
  // half-mounted or simply does not carry it, so `settled` is the only honest
  // discriminator. Getting this backwards either spins on a page that will
  // never yield, or gives up on the exact case the old in-process loop rode
  // out and then succeeded on.
  for (const { name, payload, retryable, says } of [
    {
      name: 'json-ld up, og not, poll timed out — the shape the old loop retried',
      payload: { jsonld: [JSON.stringify(RESIDENCE)], og: {}, settled: false },
      retryable: true,
      says: /zip is required/,
    },
    {
      name: 'nothing mounted at all',
      payload: { jsonld: [], og: {}, settled: false },
      retryable: true,
      says: /could not find an address/,
    },
    {
      name: 'both surfaces settled and still no address',
      payload: {
        jsonld: [],
        og: { 'og:title': 'Listings near you', 'og:description': 'Browse homes for sale' },
        settled: true,
      },
      retryable: false,
      says: /another listing site/,
    },
  ]) {
    const result = JSON.parse(harvest(payload).out.trim());

    assert.equal(result.type, 'tool_error', name);
    assert.equal(Boolean(result.retryable), retryable, name);
    assert.match(result.error, says, name);
    assert.equal(result.store, undefined, `${name}: a failed harvest proposes no write`);
  }
});

test('--harvest rejects a payload that is not the two surfaces', () => {
  for (const bad of ['not json at all', '{"og":{}}', '{"jsonld":"a string","og":{}}']) {
    const payload = JSON.parse(harvest(bad).out.trim());
    assert.equal(payload.type, 'tool_error', `rejected: ${bad}`);
    assert.ok(!payload.retryable, 'a malformed payload is the caller to fix, not the page');
  }
});

test('--harvest refuses a url that is not one', () => {
  const payload = JSON.parse(harvest({ jsonld: [], og: {}, settled: true }, 'not-a-url').out.trim());
  assert.equal(payload.type, 'tool_error');
  assert.match(payload.error, /--harvest/, 'the usage line names the mode actually being used');
});

test('the harvest expression actually runs, and reports which exit it took', async () => {
  // Every other assertion about this string is a regex over its source. It is
  // the one piece of this skill that executes somewhere we cannot reach from
  // here, so a syntax error or a renamed field would ship green and fail only
  // in the page, where the symptom is a scrape that never works.
  //
  // `Date` and `setTimeout` are shadowed as parameters so the deadline path can
  // be proven without spending ten real seconds on it.
  const makeDoc = (jsonld: string[], og: Record<string, string>) => ({
    querySelectorAll(selector: string) {
      if (selector.includes('ld+json')) return jsonld.map((textContent) => ({ textContent }));
      return Object.entries(og).map(([key, content]) => ({
        getAttribute: (attr: string) => (attr === 'property' ? key : null),
        content,
      }));
    },
  });

  const run = (doc: unknown) => {
    let clock = 0;
    const clockedDate = { now: () => clock };
    let ticks = 0;
    const instantly = (fn: () => void, ms: number) => {
      // Bounded on purpose. The interval is the only thing moving this clock
      // toward the deadline, so dropping it to 0 would spin here forever —
      // and node:test has no default per-test timeout, so the suite would hang
      // rather than fail. Fail loudly instead.
      if ((ticks += 1) > 100) throw new Error('harvest expression did not reach its deadline in 100 polls');
      clock += ms;
      fn();
    };
    return new Function('document', 'Date', 'setTimeout', `return ${HARVEST_EXPRESSION}`)(
      doc,
      clockedDate,
      instantly,
    ) as Promise<{ jsonld: string[]; og: Record<string, string>; settled: boolean }>;
  };

  const ready = await run(makeDoc(['{"@type":"House"}'], { 'og:title': '424 28th St' }));
  assert.deepEqual(ready.jsonld, ['{"@type":"House"}'], 'json-ld comes back as raw text, not parsed');
  assert.equal(ready.og['og:title'], '424 28th St');
  assert.equal(ready.settled, true, 'both surfaces present on the first read');

  const stillEmpty = await run(makeDoc([], {}));
  assert.equal(stillEmpty.settled, false, 'reached the deadline with a surface still empty');
  assert.deepEqual(stillEmpty.jsonld, []);

  // The half-mounted shape: json-ld up, og not. This is the case the old
  // in-process loop rode out, and it must read as unsettled rather than as a
  // page that simply has no address.
  const halfway = await run(makeDoc(['{"@type":"House"}'], {}));
  assert.equal(halfway.settled, false, 'one empty surface is not a settled page');

  // And the payload the expression produces must be what parseHarvest accepts.
  const { page, settled } = parseHarvest(JSON.stringify(ready), URL_);
  assert.equal(settled, true);
  assert.deepEqual(page.jsonld, [{ '@type': 'House' }], 'the two halves agree on the wire format');
});

test('a photo we cannot vet costs the pin its picture, not the listing', () => {
  // The end of the chain: extractScraped hands the bad URL on, photoDirective
  // refuses to emit one for it, and the listing is saved anyway with the user
  // told why. Asserted end-to-end because the contract that matters is "the
  // house is on the map, without a photo".
  const env = JSON.parse(
    harvest({
      jsonld: [JSON.stringify(RESIDENCE)],
      og: { ...FULL_OG, 'og:image': 'http://127.0.0.1/hero.jpg' },
      settled: true,
    }).out,
  );

  assert.equal(env.verb, 'added');
  assert.equal(env.fetch, undefined, 'no directive, so the agent fetches nothing');
  assert.ok(
    env.notes.some((n: string) => /photo unavailable/.test(n)),
    'and the user is told why',
  );
  const rows = loadStore(env.store);
  assert.equal(rows[0].scraped.photo, null, 'an honest empty photo, not a broken path');
  assert.equal(rows[0].scraped.address, '424 28th St');
});

test('a listing linking somewhere that is not the web still lands, on the page url', () => {
  // mailto: and javascript: parse, so a loop that accepted anything parseable
  // took them and then failed the record at coerceScraped — with the page URL,
  // already validated as http(s), sitting one candidate away.
  for (const url of ['mailto:agent@example.com', 'javascript:void(0)']) {
    const env = JSON.parse(
      harvest({ jsonld: [JSON.stringify({ ...RESIDENCE, url })], og: FULL_OG, settled: true }).out,
    );
    assert.equal(env.verb, 'added', `saved despite a ${url} canonical link`);
    const rows = loadStore(env.store);
    assert.equal(rows[0].scraped.listing_url, URL_, 'fell back to the page it was read from');
    assert.equal(rows[0].scraped.listing_source, 'compass.com', 'so the source label still derives');
  }
});

test('a photo directive pins the vetted address for curl', async () => {
  const d = await photoDirective('https://example.com/hero.jpg', 'a-1-ca', new URL('https://x/y'));
  assert.equal(d.url, 'https://example.com/hero.jpg');
  assert.equal(d.path, 'photos/a-1-ca.jpg');
  // host:port:ip — curl's --resolve triple. This is the whole reason the
  // guard survives being moved to a curl on the operator's Mac: the address
  // that was vetted is the address that gets connected to.
  assert.match(d.resolve, /^example\.com:443:(\d+\.\d+\.\d+\.\d+|[0-9a-f:]+)$/);
});

test('a photo on a non-public address never becomes a directive', async () => {
  // The agent runs whatever directive it is given, on a Mac that sits on the
  // tailnet and the home LAN. Refusing here is refusing there.
  for (const u of ['http://127.0.0.1/x.jpg', 'http://192.168.1.1/x.jpg', 'http://169.254.169.254/x.jpg']) {
    await assert.rejects(
      () => photoDirective(u, 'a-1-ca', new URL('https://x/y')),
      /non-public|refusing/,
      u,
    );
  }
});
