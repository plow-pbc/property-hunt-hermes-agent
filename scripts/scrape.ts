#!/usr/bin/env node
// A harvested page -> a saved property. The single entrypoint for adding or
// refreshing.
//
// The browser lives on the user's Mac, behind latch. The agent drives it with
// HARVEST_EXPRESSION below and hands the result here; this reads only
// standards-based surfaces from that payload, geocodes the address, and
// downloads the hero photo.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import * as dns from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { pathToFileURL } from 'node:url';

import { extractScraped, geocodeQuery } from './extract.ts';
import type { PageSurfaces } from './extract.ts';
import { coerceScraped, readStore, slugify, storableUrl, upsertScraped, writeStore } from './store.ts';
import type { Scraped } from './store.ts';
import { resolveDataDir } from './properties.ts';

const MAX_PHOTO_REDIRECTS = 3;
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
const PHOTO_TIMEOUT_MS = 20_000;
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
// Nominatim's usage policy requires a descriptive agent identifying the app.
const USER_AGENT = 'property-hunt/0.1 (personal property tracker; https://clawhub.ai)';

/** A failed lookup is a tool *result*, not a crashed command: the agent reads it and speaks. */
function toolError(error: string): void {
  process.stdout.write(`${JSON.stringify({ type: 'tool_error', error })}\n`);
}

function note(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * The JS the agent hands to latch's `plow_browser` eval.
 *
 * It polls INSIDE the page because `goto` resolves while a listing is still a
 * client-side shell, and reading that shell looks exactly like a bot wall. The
 * deadline is 10s rather than the 45s the in-process loop used: `plow_browser`
 * is non-deferrable and latch's call budget is 15s, so a longer poll is killed
 * mid-flight. The agent re-runs this up to three times, which restores the
 * original budget.
 *
 * `settled` is the load-bearing part. It says which exit the poll took —
 * predicate satisfied, or deadline reached — so the caller can tell "this page
 * had not finished rendering" from "this page does not carry that field"
 * without guessing from the error text. SKILL.md carries this string verbatim
 * and a test pins the two together.
 */
export const HARVEST_EXPRESSION =
  `(async () => { ` +
  `const read = () => ({ ` +
  `jsonld: [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => s.textContent), ` +
  `og: Object.fromEntries([...document.querySelectorAll('meta[property^="og:"], meta[name^="twitter:"]')]` +
  `.map(m => [m.getAttribute('property') || m.getAttribute('name'), m.content || ''])) ` +
  `}); ` +
  `const deadline = Date.now() + 10000; ` +
  `let seen = read(); ` +
  `while (Date.now() < deadline) { ` +
  `if (seen.jsonld.length && Object.keys(seen.og).length) return { ...seen, settled: true }; ` +
  `await new Promise(r => setTimeout(r, 750)); ` +
  `seen = read(); ` +
  `} ` +
  `return { ...seen, settled: false }; ` +
  `})()`;

/**
 * The agent hands back raw JSON-LD *text*, exactly as the page carries it, so
 * the tolerant parse lives here rather than in the page: one malformed block is
 * normal and the others still carry the listing.
 *
 * A payload with no `settled` reads as NOT settled. That is the safe direction:
 * it costs a retry that may not have been needed, where the other reading
 * suppresses a retry the page still needed.
 */
export function parseHarvest(raw: string, url: string): { page: PageSurfaces; settled: boolean } {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error('harvest payload is not JSON — pass the eval result through unchanged');
  }
  const shape = payload as { jsonld?: unknown; og?: unknown; settled?: unknown };
  if (!Array.isArray(shape.jsonld)) throw new Error("harvest payload has no 'jsonld' array");
  if (!shape.og || typeof shape.og !== 'object' || Array.isArray(shape.og)) {
    throw new Error("harvest payload has no 'og' object");
  }
  const jsonld: unknown[] = [];
  for (const text of shape.jsonld) {
    try {
      jsonld.push(JSON.parse(String(text)));
    } catch {
      // A single malformed block is normal; the others still carry the listing.
    }
  }
  return { page: { url, jsonld, og: shape.og as Record<string, string> }, settled: shape.settled === true };
}

/**
 * Did this page fail because it had not finished rendering, or because it does
 * not carry the field at all?
 *
 * The in-process loop answered that with time: it polled for 45s and gave up at
 * the deadline. The in-page poll answers it the same way and reports which exit
 * it took, so this reads a measurement rather than inferring intent from the
 * error text — a missing field on a half-mounted page and on a finished one
 * raise the identical message.
 */
function reportHarvestFailure(url: string, settled: boolean, problem: string): void {
  if (settled) {
    // No test of the error text. extractScraped now throws only for the
    // identity fields — address, city, state, zip — because the two
    // site-controlled URLs it used to throw on both degrade instead: a bad
    // image loses the pin its photo, a bad canonical URL falls back to the
    // page. So every way of reaching this branch IS a missing field, and the
    // conjunction that used to guard this sentence had no remaining case.
    toolError(
      `read ${url}, but it does not publish a saveable listing. Last problem: ${problem}. ` +
        'If the page genuinely does not publish that field, try this property on another ' +
        'listing site — do not supply a value of your own.',
    );
    return;
  }
  process.stdout.write(
    `${JSON.stringify({
      type: 'tool_error',
      retryable: true,
      error:
        `${url} had not rendered a saveable listing when the page was read. ` +
        `Last problem: ${problem}. Run the eval again and re-run this command — up to three attempts.`,
    })}\n`,
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
  // Judge v6 numerically, never by its text. One address has many spellings:
  // ::ffff:127.0.0.1 and ::ffff:7f00:1 are the same loopback, and matching the
  // dotted form alone let the hex form through to the very RPC port this guard
  // exists to protect.
  const bytes = ipv6Bytes(ip);
  if (!bytes) return true; // unparseable but isIP-accepted — fail closed
  if (bytes.every((b) => b === 0)) return true; // ::
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true; // ::1
  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (bytes[0] === 0xff) return true; // ff00::/8 multicast

  // Anything embedding a v4 address is judged as that v4 address: ::/64 covers
  // v4-mapped and v4-translated; 64:ff9b::/96 is NAT64.
  const embedsV4 =
    bytes.slice(0, 8).every((b) => b === 0) ||
    (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b);
  return embedsV4 ? isPrivateAddress(bytes.slice(12).join('.')) : false;
}

/** Expand any IPv6 spelling to its 16 bytes, so the checks above compare values. */
function ipv6Bytes(ip: string): number[] | null {
  const clean = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!net.isIPv6(clean)) return null;

  // A trailing dotted quad ("::ffff:127.0.0.1") is two hextets in disguise.
  let text = clean;
  const dotted = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split('.').map(Number);
    text = `${text.slice(0, -dotted[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const [head, tail] = text.split('::');
  const headParts = head ? head.split(':').filter(Boolean) : [];
  const tailParts = text.includes('::') && tail ? tail.split(':').filter(Boolean) : [];
  const parts = text.includes('::')
    ? [...headParts, ...Array(8 - headParts.length - tailParts.length).fill('0'), ...tailParts]
    : headParts;
  if (parts.length !== 8) return null;

  const bytes: number[] = [];
  for (const part of parts) {
    const value = Number.parseInt(part, 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null;
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes;
}

/**
 * Resolve a destination once and return the exact address we vetted.
 *
 * Returning the address is the whole point. Validating a *name* and then
 * letting the HTTP client resolve it again is two lookups, and an attacker who
 * controls the domain can answer them differently — public for the check,
 * loopback for the connect. The caller pins to this address, so there is only
 * ever one resolution to poison.
 */
export async function resolvePublicDestination(
  raw: string,
  base?: URL,
): Promise<{ url: URL; address: string; family: number }> {
  const url = new URL(raw, base);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`refusing a ${url.protocol} image URL`);
  }
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  const resolved = net.isIP(literal)
    ? [{ address: literal, family: net.isIP(literal) }]
    : await dns.lookup(url.hostname, { all: true });

  if (resolved.length === 0) throw new Error(`could not resolve ${url.hostname}`);
  // Every answer must be public: accepting the name because *one* record is
  // public would let an attacker mix in a decoy and still win on the rest.
  if (resolved.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error(`refusing a request to a non-public address (${url.hostname})`);
  }
  return { url, address: resolved[0].address, family: resolved[0].family };
}

/**
 * GET the vetted address, keeping the URL's Host header and TLS servername so
 * pinning breaks neither virtual hosting nor certificate validation.
 */
function getPinned(
  url: URL,
  address: string,
  family: number,
): Promise<{ status: number; location: string | null; type: string; body: Buffer }> {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.get(
      url,
      {
        headers: { 'User-Agent': USER_AGENT },
        // Connect to the address already vetted, not to whatever the name
        // resolves to on a second lookup. Node's happy-eyeballs path calls
        // lookup with { all: true } and expects an array — answering only the
        // single-address form yields "Invalid IP address: undefined".
        lookup: (_host: string, opts: { all?: boolean }, done: Function) =>
          opts?.all ? done(null, [{ address, family }]) : done(null, address, family),
        servername: url.hostname.replace(/^\[|\]$/g, ''),
      } as never,
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_PHOTO_BYTES) {
            request.destroy();
            reject(new Error(`image exceeds ${MAX_PHOTO_BYTES / 1024 / 1024} MB`));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            location: (response.headers.location as string | undefined) ?? null,
            type: (response.headers['content-type'] as string | undefined) ?? '',
            body: Buffer.concat(chunks),
          }),
        );
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.setTimeout(PHOTO_TIMEOUT_MS, () => request.destroy(new Error('image request timed out')));
  });
}

async function downloadPhoto(photoUrl: string, dir: string, id: string, base: URL): Promise<string> {
  // Every hop is resolved and vetted, then connected to by address — a public
  // URL that 302s inward, or a name that rebinds between check and connect,
  // both fail here rather than reaching the network behind us.
  let hop = await resolvePublicDestination(photoUrl, base);
  let response = await getPinned(hop.url, hop.address, hop.family);

  for (let redirects = 0; response.status >= 300 && response.status < 400; redirects += 1) {
    if (redirects >= MAX_PHOTO_REDIRECTS) throw new Error(`too many redirects (over ${MAX_PHOTO_REDIRECTS})`);
    if (!response.location) throw new Error(`HTTP ${response.status} with no redirect target`);
    hop = await resolvePublicDestination(response.location, hop.url);
    response = await getPinned(hop.url, hop.address, hop.family);
  }

  if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
  if (!response.type.startsWith('image/')) {
    throw new Error(`not an image (${response.type || 'no content-type'})`);
  }

  const ext = response.type.includes('png') ? '.png' : response.type.includes('webp') ? '.webp' : '.jpg';
  const relative = path.join('photos', `${id}${ext}`);
  const destination = path.join(dir, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  // Same atomic discipline as the store: the page may be open on this file.
  const tmp = `${destination}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, response.body);
  fs.renameSync(tmp, destination);
  return relative;
}

/**
 * A refresh replaces `scraped` wholesale, so a transient geocoder outage or a
 * dead image host would blank a pin or photo we already had — losing data on
 * what is meant to be a routine price check. Enrichment that failed this run
 * keeps whatever the last successful run found. Returns what was kept.
 */
export function keepPreviousEnrichment(
  scraped: Scraped,
  previous: Scraped | undefined,
  dir: string,
): string[] {
  if (!previous) return [];
  const kept: string[] = [];
  if (scraped.lat === null && previous.lat !== null) {
    scraped.lat = previous.lat;
    scraped.lng = previous.lng;
    kept.push('coordinates');
  }
  // Only carry a photo whose file is still there. Keeping the path blind would
  // paper over a failed download with a record pointing at nothing, which the
  // map renders as a broken image — worse than the honest plain marker.
  const photoOnDisk = previous.photo !== null && fs.existsSync(path.join(dir, previous.photo));
  if (scraped.photo === null && photoOnDisk) {
    scraped.photo = previous.photo;
    kept.push('photo');
  }
  return kept;
}

async function main(): Promise<void> {
  const url = process.argv[2] === '--harvest' ? (process.argv[4] ?? '') : '';
  if (!storableUrl(url)) {
    toolError("usage: node scrape.ts --harvest '<eval-result-json>' '<listing-url>'");
    return;
  }

  // Read before opening the browser. This is the guard: a missing or damaged
  // store fails here with an actionable message, rather than after the scrape,
  // the geocode, and a photo download that has already written an image.
  // It also gives us what this property looked like before the refresh.
  const dir = resolveDataDir();
  const before = readStore(dir);

  let scraped: Scraped;
  let photoUrl: string | null;
  let page: PageSurfaces;
  let settled: boolean;
  try {
    ({ page, settled } = parseHarvest(process.argv[3] ?? '', url));
  } catch (err) {
    // The caller's payload, not the page — another poll changes nothing.
    return toolError((err as Error).message);
  }
  try {
    const extracted = extractScraped(page);
    // The same rules `upsert` applies, so anything unsaveable fails here,
    // before the geocode and photo download that would otherwise leave an
    // orphaned image named for a slug no row will ever carry.
    scraped = coerceScraped(extracted.scraped);
    photoUrl = extracted.photoUrl;
  } catch (err) {
    return reportHarvestFailure(url, settled, (err as Error).message);
  }

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
      scraped.photo = await downloadPhoto(photoUrl, dir, id, new URL(url));
    } catch (err) {
      note(`photo download failed (${(err as Error).message}) — the pin will use a plain marker`);
    }
  }

  for (const field of keepPreviousEnrichment(scraped, before.find((row) => row.id === id)?.scraped, dir)) {
    note(`kept the previous ${field} for ${id}`);
  }

  const next = upsertScraped(before, scraped);
  writeStore(dir, next);
  process.stdout.write(`${next.length > before.length ? 'added' : 'refreshed'} ${id}\n`);
}

// Only run when invoked directly, so tests can import the pieces above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    const name = (err as Error & { name?: string })?.name ?? 'Error';
    const detail = String((err as Error)?.message ?? err);
    toolError(detail.startsWith(`${name}:`) ? detail : `${name}: ${detail}`);
  });
}
