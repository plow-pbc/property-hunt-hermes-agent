import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { scrapeRendered } from './scrape.ts';

// A stand-in for the Camoufox proxy. Only `goto` and `eval` are used, and
// `eval` is dispatched on which surface the caller asked for — so a page can be
// made to render in stages, which is the whole point of the retry loop.
function fakeBrowser(states: Array<{ jsonld: unknown[]; og: Record<string, string> }>) {
  let poll = 0;
  return {
    polls: () => poll,
    async goto() {},
    async eval(expression: string) {
      // One harvest reads json-ld then og. Both must see the SAME state or the
      // fake invents a half-and-half page that never occurs in reality.
      const current = states[Math.min(poll, states.length - 1)];
      if (expression.includes('ld+json')) {
        return current.jsonld.map((block) => JSON.stringify(block));
      }
      poll += 1; // og is read second — advance only once the harvest is done
      return current.og;
    },
  };
}

// The give-up path waits out the full render budget, so tests pass a short one
// rather than sitting through the 45s production default.
const SHORT_TIMEOUT_MS = 2_000;

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

test('a page that renders in stages is retried, not abandoned', async () => {
  // Poll 1: JSON-LD has mounted (no postalCode) but og:title has not, so the
  // record is unkeyable. Poll 2: og:title arrives and it becomes saveable.
  // Before the retry landed inside the loop, poll 1 aborted the whole run.
  const browser = fakeBrowser([
    { jsonld: [RESIDENCE], og: {} },
    { jsonld: [RESIDENCE], og: FULL_OG },
  ]);

  const { scraped } = await scrapeRendered(browser, URL_);

  assert.equal(scraped.zip, '94131');
  assert.equal(scraped.city, 'San Francisco');
  assert.equal(scraped.price, 3250000);
  assert.ok(browser.polls() > 1, 'the first poll must not have been treated as final');
});

test('a page that never becomes saveable reports what was missing and where', async () => {
  const browser = fakeBrowser([{ jsonld: [RESIDENCE], og: {} }]);

  await assert.rejects(
    () => scrapeRendered(browser, URL_, SHORT_TIMEOUT_MS),
    (err: Error) => {
      assert.match(err.message, /could not read a saveable listing/);
      assert.match(err.message, /424-28th-St/, 'the URL is needed to act on this');
      assert.match(err.message, /zip is required/, 'and the actual blocker');
      assert.match(err.message, /another listing site/, 'a missing field is worth trying elsewhere');
      return true;
    },
  );
});

test('a browser failure is not reported as a missing field', async () => {
  // A bot wall or a browser that goes away mid-run lands in the same catch.
  // Telling the agent to "try another listing site" would send it after the
  // wrong problem entirely.
  const broken = {
    async goto() {},
    async eval() {
      throw Object.assign(new Error('connection refused'), { name: 'BrowserRpcError' });
    },
  };

  await assert.rejects(
    () => scrapeRendered(broken, URL_, SHORT_TIMEOUT_MS),
    (err: Error) => {
      assert.match(err.message, /connection refused/);
      assert.doesNotMatch(err.message, /another listing site/);
      return true;
    },
  );
});

test('scraping into an uninitialized folder costs nothing and says what to do', async () => {
  // The guard runs before connect(), so this needs no browser. Without it,
  // readStore raised a bare ENOENT *after* the browser run, the geocode, and a
  // photo download that had already created photos/ and an orphaned image.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'property-hunt-uninit-'));
  const out = execFileSync(
    process.execPath,
    [fileURLToPath(new URL('./scrape.ts', import.meta.url)), 'https://example.com/listing/1'],
    { env: { ...process.env, PROPERTY_HUNT_DIR: dir }, encoding: 'utf8' },
  );

  const payload = JSON.parse(out.trim());
  assert.equal(payload.type, 'tool_error');
  assert.match(payload.error, /no store at/);
  assert.match(payload.error, /node properties\.ts init/, 'the message has to say what to run');
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing may be written before the store is known to exist');
});
