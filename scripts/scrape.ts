#!/usr/bin/env node
// Listing URL -> a saved property. The single entrypoint for adding or
// refreshing: it scrapes, geocodes, downloads the photo, and writes the store.
//
// Runs the page through Camoufox (plain HTTP gets a bot wall), reads only
// standards-based surfaces, geocodes the address, and downloads the hero photo.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import * as dns from 'node:dns/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { extractScraped, geocodeQuery } from './extract.ts';
import type { PageSurfaces } from './extract.ts';
import { coerceScraped, readStore, slugify, upsertScraped, writeStore } from './store.ts';
import type { Scraped } from './store.ts';
import { resolveDataDir } from './properties.ts';

const require = createRequire(import.meta.url);

const RENDER_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 750;
const MAX_PHOTO_REDIRECTS = 3;
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
// Nominatim's usage policy requires a descriptive agent identifying the app.
const USER_AGENT = 'property-hunt/0.1 (personal property tracker; https://clawhub.ai)';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A browser failure is a tool *result*, not a crashed command — see plow-browser-usage. */
function toolError(error: string): void {
  process.stdout.write(`${JSON.stringify({ type: 'tool_error', error })}\n`);
}

function note(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Read the page's structured surfaces. Deliberately no DOM selectors: only
 * JSON-LD and Open Graph, so a cosmetic redesign can't break the scrape.
 */
async function harvest(browser: any, url: string): Promise<PageSurfaces> {
  const jsonldText: string[] = await browser.eval(
    `[...document.querySelectorAll('script[type="application/ld+json"]')].map(s => s.textContent)`,
  );
  const og: Record<string, string> = await browser.eval(
    `Object.fromEntries([...document.querySelectorAll('meta[property^="og:"], meta[name^="twitter:"]')]
       .map(m => [m.getAttribute('property') || m.getAttribute('name'), m.content || '']))`,
  );
  const jsonld: unknown[] = [];
  for (const text of jsonldText ?? []) {
    try {
      jsonld.push(JSON.parse(text));
    } catch {
      // A single malformed block is normal; the others still carry the listing.
    }
  }
  return { url, jsonld, og: og ?? {} };
}

/**
 * `goto` resolves while the page is still a client-side shell — a fixed sleep
 * either wastes time or reads an empty page and looks exactly like a bot wall.
 * Poll instead, until the page yields a record the store will actually accept.
 *
 * Validating *inside* the loop is the point: a page can mount its JSON-LD
 * (whose PostalAddress often has no postalCode) before the og:title that
 * carries the full "…, San Francisco, CA 94131" line. Checking only after the
 * loop would abort on that half-rendered state when one more poll would have
 * produced a saveable record — the retry mechanism has to be able to see the
 * failure it exists to ride out.
 */
export async function scrapeRendered(
  browser: any,
  url: string,
  timeoutMs: number = RENDER_TIMEOUT_MS,
): Promise<{ scraped: Scraped; photoUrl: string | null }> {
  await browser.goto(url);
  const deadline = Date.now() + timeoutMs;
  let lastError = 'page never rendered a listing';
  while (Date.now() < deadline) {
    try {
      const { scraped, photoUrl } = extractScraped(await harvest(browser, url));
      // The same rules `upsert` applies — so anything unsaveable fails here,
      // before the geocode and photo download that would otherwise leave an
      // orphaned image named for a slug no row will ever carry.
      return { scraped: coerceScraped(scraped), photoUrl };
    } catch (err) {
      lastError = (err as Error).message;
      await sleep(POLL_INTERVAL_MS);
    }
  }
  // Everything the loop swallows lands here — a thin page, but also a bot
  // wall, a page crash, or a browser that went away mid-run. Only offer the
  // "try another site" remedy when the page actually rendered and simply
  // lacked a field; prescribing it for a browser failure sends the agent off
  // after the wrong problem.
  const missingField = /is required|could not find an address|no usable characters/.test(lastError);
  throw new Error(
    `could not read a saveable listing from ${url} after ${timeoutMs / 1000}s. ` +
      `Last problem: ${lastError}.` +
      (missingField
        ? ' If the page genuinely does not publish that field, try this property on another' +
          ' listing site — do not supply a value of your own.'
        : ''),
  );
}

/** Keyless, same OpenStreetMap ecosystem the map tiles come from. */
async function geocode(scraped: Scraped): Promise<{ lat: number; lng: number } | null> {
  const query = geocodeQuery(scraped);
  const response = await fetch(`${NOMINATIM}?q=${encodeURIComponent(query)}&format=json&limit=1`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`geocoder returned HTTP ${response.status}`);
  const hits = (await response.json()) as Array<{ lat: string; lon: string }>;
  if (!hits.length) return null;
  return { lat: Number(hits[0].lat), lng: Number(hits[0].lon) };
}

/**
 * Is this address one we must never issue a request to?
 *
 * The hero-image URL comes from the listing page's own JSON-LD or og:image, so
 * it is attacker-controlled text. Without this, a hostile listing could point
 * og:image at 127.0.0.1 or a RFC1918 host and use us as a blind probe into
 * whatever the agent container can reach.
 */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    return a >= 224; // multicast and reserved
  }
  const ipv6 = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (ipv6 === '::1' || ipv6 === '::') return true;
  if (/^(fc|fd|fe80|ff)/.test(ipv6)) return true;
  // ::ffff:127.0.0.1 and friends — judge the embedded v4 address.
  const embedded = ipv6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return embedded ? isPrivateAddress(embedded[1]) : false;
}

/**
 * Resolve and vet a destination before fetching it. Not proof against DNS
 * rebinding — the name could resolve differently between this check and the
 * connect — but it stops the realistic attack, which is a listing page simply
 * naming an internal host or address.
 */
export async function assertPublicDestination(raw: string, base?: URL): Promise<URL> {
  const url = new URL(raw, base);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`refusing a ${url.protocol} image URL`);
  }
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(literal)
    ? [literal]
    : (await dns.lookup(url.hostname, { all: true })).map((entry) => entry.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error(`refusing a request to a non-public address (${url.hostname})`);
  }
  return url;
}

async function downloadPhoto(photoUrl: string, dir: string, id: string): Promise<string> {
  // Follow redirects by hand so every hop is vetted, not just the first — a
  // public URL that 302s to 127.0.0.1 would otherwise walk straight through.
  let target = await assertPublicDestination(photoUrl);
  let response: Response | undefined;
  for (let hop = 0; hop <= MAX_PHOTO_REDIRECTS; hop++) {
    response = await fetch(target, { headers: { 'User-Agent': USER_AGENT }, redirect: 'manual' });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get('location');
    if (!location) throw new Error(`HTTP ${response.status} with no redirect target`);
    target = await assertPublicDestination(location, target);
    response = undefined;
  }
  if (!response) throw new Error(`too many redirects (over ${MAX_PHOTO_REDIRECTS})`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const type = response.headers.get('content-type') ?? '';
  if (!type.startsWith('image/')) throw new Error(`not an image (${type || 'no content-type'})`);

  const ext = type.includes('png') ? '.png' : type.includes('webp') ? '.webp' : '.jpg';
  const relative = path.join('photos', `${id}${ext}`);
  const destination = path.join(dir, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  // Same atomic discipline as the store: the page may be open on this file.
  const tmp = `${destination}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, Buffer.from(await response.arrayBuffer()));
  fs.renameSync(tmp, destination);
  return relative;
}

/**
 * A refresh replaces `scraped` wholesale, so a transient geocoder outage or a
 * dead image host would blank a pin or photo we already had — losing data on
 * what is meant to be a routine price check. Enrichment that failed this run
 * keeps whatever the last successful run found. Returns what was kept.
 */
export function keepPreviousEnrichment(scraped: Scraped, previous: Scraped | undefined): string[] {
  if (!previous) return [];
  const kept: string[] = [];
  if (scraped.lat === null && previous.lat !== null) {
    scraped.lat = previous.lat;
    scraped.lng = previous.lng;
    kept.push('coordinates');
  }
  if (scraped.photo === null && previous.photo !== null) {
    scraped.photo = previous.photo;
    kept.push('photo');
  }
  return kept;
}

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url || !/^https?:\/\//i.test(url)) {
    toolError("usage: node scrape.ts '<listing-url>'");
    return;
  }

  // Read before opening the browser. This is the guard: a missing or damaged
  // store fails here with an actionable message, rather than after the scrape,
  // the geocode, and a photo download that has already written an image.
  // It also gives us what this property looked like before the refresh.
  const dir = resolveDataDir();
  const before = readStore(dir);

  const { connect } = require('plow-browser');
  let browser: any;
  try {
    browser = connect(process.env.CAMOUFOX_RPC_ENDPOINT);
  } catch (err) {
    if ((err as Error & { name?: string })?.name === 'BrowserNotConnected') {
      return toolError('browser unavailable: endpoint not provisioned — enable Plow Browser in Settings');
    }
    throw err;
  }

  const { scraped, photoUrl } = await scrapeRendered(browser, url);
  const id = slugify(scraped);

  // Neither of the next two failures should lose the listing: a property with
  // no pin is still worth having, and the frontend surfaces it explicitly.
  try {
    const point = await geocode(scraped);
    if (point) {
      scraped.lat = point.lat;
      scraped.lng = point.lng;
    } else {
      note(`no coordinates found for "${scraped.address}" — it will show under "not on the map"`);
    }
  } catch (err) {
    note(`geocoding failed (${(err as Error).message}) — it will show under "not on the map"`);
  }

  if (photoUrl) {
    try {
      scraped.photo = await downloadPhoto(photoUrl, dir, id);
    } catch (err) {
      note(`photo download failed (${(err as Error).message}) — the pin will use a plain marker`);
    }
  }

  for (const field of keepPreviousEnrichment(scraped, before.find((row) => row.id === id)?.scraped)) {
    note(`kept the previous ${field} for ${id}`);
  }

  const next = upsertScraped(before, scraped);
  writeStore(dir, next);
  process.stdout.write(`${next.length > before.length ? 'added' : 'refreshed'} ${id}\n`);
}

// Only run when invoked directly, so tests can import scrapeRendered.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    const name = (err as Error & { name?: string })?.name ?? 'Error';
    const detail = String((err as Error)?.message ?? err);
    toolError(
      name === 'BrowserNotConnected'
        ? 'browser unavailable: service unreachable (it may be restarting — retry once after 60s)'
        : detail.startsWith(`${name}:`)
          ? detail
          : `${name}: ${detail}`,
    );
  });
}
