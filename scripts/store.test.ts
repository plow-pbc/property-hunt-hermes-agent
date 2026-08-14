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
  const canonical = slugify('424 28th Street', 'San Francisco', 'CA');
  for (const variant of ['424 28th St', '424 28th st.', '424  28TH  STREET', '424 28th Street,']) {
    assert.equal(slugify(variant, 'san francisco', 'ca'), canonical, `${variant} should collapse`);
  }
});

test('different houses do not collide', () => {
  assert.notEqual(
    slugify('424 28th St', 'San Francisco', 'CA'),
    slugify('424 28th Ave', 'San Francisco', 'CA'),
  );
  assert.notEqual(
    slugify('424 28th St', 'San Francisco', 'CA'),
    slugify('424 28th St', 'Oakland', 'CA'),
  );
});

test('a unit number distinguishes two homes at one street address', () => {
  assert.notEqual(
    slugify('1501 Greenwich Street, Unit 101', 'San Francisco', 'CA'),
    slugify('1501 Greenwich Street, Unit 202', 'San Francisco', 'CA'),
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

// --- Durability -------------------------------------------------------------

test('a write survives a round trip through the filesystem', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'data.js'), emptyStoreText());
  const rows = upsertScraped(readStore(dir), scraped());
  writeStore(dir, rows);
  assert.deepEqual(readStore(dir), rows);
});

test('a write leaves no scratch files behind', () => {
  const dir = tmpdir();
  writeStore(dir, upsertScraped([], scraped()));
  assert.deepEqual(fs.readdirSync(dir), ['data.js'], 'the tmp file must be renamed, not left alongside');
});
