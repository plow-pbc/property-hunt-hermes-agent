#!/usr/bin/env node
// Listing URL -> a Scraped record on stdout, ready to hand to
// `properties.ts upsert --scraped`.
//
// Runs the page through Camoufox (plain HTTP gets a bot wall), reads only
// standards-based surfaces, geocodes the address, and downloads the hero photo.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

import { extractScraped, geocodeQuery } from './extract.ts';
import type { PageSurfaces } from './extract.ts';
import { coerceScraped, slugify } from './store.ts';
import type { Scraped } from './store.ts';
import { resolveDataDir } from './properties.ts';

const require = createRequire(import.meta.url);

const RENDER_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 750;
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
 * Poll for the real success condition instead: surfaces the parser can use.
 */
async function scrapeRendered(browser: any, url: string): Promise<ReturnType<typeof extractScraped>> {
  await browser.goto(url);
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  let lastError = 'page never rendered a listing';
  while (Date.now() < deadline) {
    try {
      return extractScraped(await harvest(browser, url));
    } catch (err) {
      lastError = (err as Error).message;
      await sleep(POLL_INTERVAL_MS);
    }
  }
  throw new Error(`gave up after ${RENDER_TIMEOUT_MS / 1000}s: ${lastError}`);
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

async function downloadPhoto(photoUrl: string, dir: string, id: string): Promise<string> {
  const response = await fetch(photoUrl, { headers: { 'User-Agent': USER_AGENT } });
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

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url || !/^https?:\/\//i.test(url)) {
    toolError('usage: scrape.ts <listing-url>');
    return;
  }

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

  const { scraped: parsed, photoUrl } = await scrapeRendered(browser, url);

  // Validate with the exact rules `upsert` applies, before spending anything.
  // A record that cannot be saved must fail here — otherwise we geocode it,
  // download its photo, print it, and only then have upsert reject it, leaving
  // an orphaned image named after a slug no row will ever carry.
  const scraped = coerceScraped(parsed);
  const id = slugify(scraped);
  const dir = resolveDataDir();

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

  process.stdout.write(`${JSON.stringify(scraped, null, 2)}\n`);
}

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
