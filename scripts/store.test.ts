import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  slugify,
  parseStore,
  serializeStore,
  readStore,
  writeStore,
  upsertScraped,
  setMine,
  emptyStoreText,
  coerceScraped,
  removeProperty,
} from './store.ts';
import type { Scraped } from './store.ts';

function scraped(over: Partial<Scraped> = {}): Scraped {
  return {
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
    listing_source: 'compass.com',
    photo: null,
    last_scraped_at: '2026-08-14T19:00:00.000Z',
    ...over,
  };
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'property-hunt-test-'));
}

// --- The invariant the whole design rests on -------------------------------

test('re-scraping a property leaves the user judgments untouched', () => {
  let rows = upsertScraped([], scraped());
  rows = setMine(rows, rows[0].id, 'rating', '4');
  rows = setMine(rows, rows[0].id, 'notes', 'needs a new roof');
  rows = setMine(rows, rows[0].id, 'status', 'toured');
  const addedAt = rows[0].mine.added_at;

  // Price cut + went pending: everything scraped changes.
  rows = upsertScraped(rows, scraped({ price: 2950000, listing_status: 'pending' }));

  assert.equal(rows.length, 1, 'a re-scrape must update in place, not append');
  assert.equal(rows[0].scraped.price, 2950000);
  assert.equal(rows[0].scraped.listing_status, 'pending');
  assert.equal(rows[0].mine.rating, 4);
  assert.equal(rows[0].mine.notes, 'needs a new roof');
  assert.equal(rows[0].mine.status, 'toured');
  assert.equal(rows[0].mine.added_at, addedAt, 'added_at is when *I* added it, not when it was last scraped');
});

test('a newly added property gets neutral defaults a user has not set yet', () => {
  const rows = upsertScraped([], scraped());
  assert.equal(rows[0].mine.rating, null);
  assert.equal(rows[0].mine.status, 'new');
  assert.equal(rows[0].mine.notes, '');
  assert.ok(rows[0].mine.added_at, 'added_at is stamped on creation');
});

// --- Provenance: scraped values may only come from a scrape ----------------

test('set refuses fields outside the user-owned block', () => {
  const rows = upsertScraped([], scraped());
  for (const field of ['price', 'lat', 'listing_url', 'last_scraped_at', 'id', 'nonsense']) {
    assert.throws(
      () => setMine(rows, rows[0].id, field, '1'),
      /settable fields/,
      `set must reject ${field} — scraped values would then lie about their provenance`,
    );
  }
});

test('set on an unknown property fails loudly rather than creating one', () => {
  assert.throws(() => setMine([], 'no-such-house', 'rating', '3'), /no property with id/);
});

test('rating only accepts 1-5', () => {
  const rows = upsertScraped([], scraped());
  for (const bad of ['0', '6', '3.5', 'great', '']) {
    assert.throws(() => setMine(rows, rows[0].id, 'rating', bad), /rating must be/);
  }
  assert.equal(setMine(rows, rows[0].id, 'rating', '5')[0].mine.rating, 5);
});

// --- Dedup ------------------------------------------------------------------

test('the same house written different ways is the same house', () => {
  const canonical = slugify({ address: '424 28th Street', city: 'San Francisco', state: 'CA', zip: '94131' });
  for (const variant of ['424 28th St', '424 28th st.', '424  28TH  STREET', '424 28th Street,']) {
    assert.equal(
      slugify({ address: variant, city: 'san francisco', state: 'ca', zip: '94131' }),
      canonical,
      `${variant} should collapse`,
    );
  }
});

test('a neighborhood and its city are the same house', () => {
  // Compass reports addressLocality as the neighborhood on a detail page and
  // the city on a search page. Keying on zip is what keeps those one record.
  assert.equal(
    slugify({ address: '424 28th St', city: 'Noe Valley', state: 'CA', zip: '94131' }),
    slugify({ address: '424 28th St', city: 'San Francisco', state: 'CA', zip: '94131' }),
  );
});

test('different houses do not collide', () => {
  const sf = { city: 'San Francisco', state: 'CA', zip: '94131' };
  assert.notEqual(slugify({ ...sf, address: '424 28th St' }), slugify({ ...sf, address: '424 28th Ave' }));
  assert.notEqual(
    slugify({ address: '424 28th St', city: 'San Francisco', state: 'CA', zip: '94131' }),
    slugify({ address: '424 28th St', city: 'Oakland', state: 'CA', zip: '94609' }),
  );
});

test('a listing with no zip still gets a usable key', () => {
  assert.equal(
    slugify({ address: '424 28th St', city: 'San Francisco', state: 'CA', zip: '' }),
    '424-28th-st-san-francisco-ca',
  );
});

test('a unit number distinguishes two homes at one street address', () => {
  const at = { city: 'San Francisco', state: 'CA', zip: '94123' };
  assert.notEqual(
    slugify({ ...at, address: '1501 Greenwich Street, Unit 101' }),
    slugify({ ...at, address: '1501 Greenwich Street, Unit 202' }),
  );
});

// --- File format ------------------------------------------------------------

test('what we write is what we can read back', () => {
  const rows = upsertScraped([], scraped());
  assert.deepEqual(parseStore(serializeStore(rows)), rows);
});

test('an empty store is a valid store', () => {
  assert.deepEqual(parseStore(emptyStoreText()), []);
});

test('the store file is loadable by a browser as a plain script', () => {
  const text = serializeStore(upsertScraped([], scraped()));
  assert.match(text.split('\n')[0], /^window\.PROPERTIES =$/, 'the frontend loads this with <script src>, not fetch');
});

// --- Loud failure: the store is irreplaceable user data ---------------------

test('a corrupt store throws instead of silently becoming an empty one', () => {
  for (const bad of [
    'window.PROPERTIES =\n[{"id": "broken"',
    'window.PROPERTIES =\n{"not": "an array"}',
    'some other file entirely',
    '',
    '   ',
  ]) {
    assert.throws(
      () => parseStore(bad),
      /data\.js/,
      `refusing ${JSON.stringify(bad.slice(0, 25))} protects the user's history from a silent reset`,
    );
  }
});

// --- Agent-supplied input ---------------------------------------------------

test('a listing from any site is accepted and labeled by its host', () => {
  for (const [url, expected] of [
    ['https://www.compass.com/homedetails/x/1_pid/', 'compass.com'],
    ['https://www.zillow.com/homedetails/x/1_zpid/', 'zillow.com'],
    ['https://redfin.com/CA/SF/x', 'redfin.com'],
  ] as const) {
    const out = coerceScraped({ address: '1 A St', city: 'SF', state: 'CA', listing_url: url });
    assert.equal(out.listing_source, expected);
  }
});

test('missing optional fields become null rather than undefined', () => {
  const out = coerceScraped({ address: '1 A St', city: 'SF', state: 'CA', listing_url: 'https://x.com/y' });
  for (const key of ['lat', 'lng', 'price', 'beds', 'baths', 'sqft', 'photo'] as const) {
    assert.equal(out[key], null, `${key} must be null so JSON.stringify keeps it visible`);
  }
  assert.ok(out.last_scraped_at, 'a scrape timestamp is stamped even when the caller omits it');
});

test('input that would corrupt the dedup key is rejected', () => {
  const base = { address: '1 A St', city: 'SF', state: 'CA', listing_url: 'https://x.com/y' };
  assert.throws(() => coerceScraped({ ...base, address: '' }), /address is required/);
  assert.throws(() => coerceScraped({ ...base, city: undefined }), /city is required/);
  assert.throws(() => coerceScraped({ ...base, listing_url: 'not-a-url' }), /listing_url/);
  assert.throws(() => coerceScraped({ ...base, price: 'a lot' }), /price must be a number/);
  assert.throws(() => coerceScraped('nope'), /must be a JSON object/);
});

// --- Durability -------------------------------------------------------------

test('a write survives a round trip through the filesystem', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'data.js'), emptyStoreText());
  const rows = upsertScraped(readStore(dir), scraped());
  writeStore(dir, rows);
  assert.deepEqual(readStore(dir), rows);
});

test('removing a property that is not there fails loudly', () => {
  const rows = upsertScraped([], scraped());
  assert.throws(() => removeProperty(rows, 'no-such-house'), /no property with id/);
  assert.deepEqual(removeProperty(rows, rows[0].id), []);
});

test('a write leaves no scratch files behind', () => {
  const dir = tmpdir();
  writeStore(dir, upsertScraped([], scraped()));
  assert.deepEqual(fs.readdirSync(dir), ['data.js'], 'the tmp file must be renamed, not left alongside');
});
