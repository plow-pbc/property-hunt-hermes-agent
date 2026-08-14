// The store. `data.js` is the single source of truth AND the file the frontend
// loads — a file:// page cannot fetch(), so anything else would need a derived
// export that can silently go stale. This module is its only writer.
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Scraped from a listing. Replaced wholesale on every re-scrape. */
export type Scraped = {
  address: string;
  city: string;
  state: string;
  zip: string;
  lat: number | null;
  lng: number | null;
  price: number | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  property_type: string | null;
  listing_status: string | null;
  listing_url: string;
  listing_source: string;
  photo: string | null;
  last_scraped_at: string;
};

/** The user's own judgments. A re-scrape must never touch these. */
export type Mine = {
  rating: number | null;
  status: string;
  notes: string;
  added_at: string;
};

export type Property = { id: string; scraped: Scraped; mine: Mine };

export const MINE_FIELDS = ['rating', 'status', 'notes'] as const;

const HEADER = 'window.PROPERTIES =';

// Street-type abbreviations, so "424 28th Street" and "424 28th St" are one house.
const SUFFIXES: Record<string, string> = {
  street: 'st',
  avenue: 'ave',
  road: 'rd',
  drive: 'dr',
  boulevard: 'blvd',
  lane: 'ln',
  court: 'ct',
  place: 'pl',
  terrace: 'ter',
  circle: 'cir',
  parkway: 'pkwy',
  highway: 'hwy',
  square: 'sq',
  trail: 'trl',
  north: 'n',
  south: 's',
  east: 'e',
  west: 'w',
};

function normalizeWords(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => SUFFIXES[word] ?? word)
    .join('-');
}

/** The dedup key. Same house written any reasonable way → same slug. */
export function slugify(address: string, city: string, state: string): string {
  return [address, city, state].map(normalizeWords).filter(Boolean).join('-');
}

export function emptyStoreText(): string {
  return serializeStore([]);
}

export function serializeStore(rows: Property[]): string {
  return `${HEADER}\n${JSON.stringify(rows, null, 2)}\n`;
}

/**
 * Parse `data.js`. Throws on anything unexpected — this file is irreplaceable
 * user data, so "recovering" by returning an empty store would silently destroy
 * their history. A loud failure is always the better outcome here.
 */
export function parseStore(text: string): Property[] {
  if (text.trim() === '') {
    throw new Error('data.js is empty — refusing to treat that as an empty store');
  }
  const firstBreak = text.indexOf('\n');
  const firstLine = firstBreak === -1 ? text : text.slice(0, firstBreak);
  if (!firstLine.includes('window.PROPERTIES')) {
    throw new Error(
      `data.js is malformed: expected it to start with "${HEADER}", got ${JSON.stringify(firstLine.slice(0, 60))}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(firstBreak + 1));
  } catch (err) {
    throw new Error(`data.js contains malformed JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`data.js must contain a JSON array, got ${typeof parsed}`);
  }
  return parsed as Property[];
}

export function dataFile(dir: string): string {
  return path.join(dir, 'data.js');
}

export function readStore(dir: string): Property[] {
  return parseStore(fs.readFileSync(dataFile(dir), 'utf8'));
}

/** Atomic: the frontend may have the file open, and a torn write loses everything. */
export function writeStore(dir: string, rows: Property[]): void {
  const tmp = path.join(dir, `.data.js.tmp-${process.pid}`);
  fs.writeFileSync(tmp, serializeStore(rows));
  fs.renameSync(tmp, dataFile(dir));
}

/** Create or refresh. Replaces `scraped` wholesale; preserves `mine` exactly. */
export function upsertScraped(
  rows: Property[],
  scraped: Scraped,
  now: string = new Date().toISOString(),
): Property[] {
  const id = slugify(scraped.address, scraped.city, scraped.state);
  const index = rows.findIndex((row) => row.id === id);
  if (index === -1) {
    return [...rows, { id, scraped, mine: { rating: null, status: 'new', notes: '', added_at: now } }];
  }
  const next = rows.slice();
  next[index] = { id, scraped, mine: rows[index].mine };
  return next;
}

/**
 * Write one user-owned field. Scraped fields are deliberately unreachable here:
 * they may only come from a scrape, so `last_scraped_at` never lies about where
 * a value came from.
 */
export function setMine(rows: Property[], id: string, field: string, value: string): Property[] {
  if (!(MINE_FIELDS as readonly string[]).includes(field)) {
    throw new Error(
      `cannot set ${JSON.stringify(field)} — settable fields are ${MINE_FIELDS.join(', ')} ` +
        '(everything else comes from a scrape)',
    );
  }
  const index = rows.findIndex((row) => row.id === id);
  if (index === -1) {
    throw new Error(`no property with id ${JSON.stringify(id)}`);
  }

  const mine: Mine = { ...rows[index].mine };
  if (field === 'rating') {
    const rating = Number(value);
    if (!/^\d+$/.test(value.trim()) || !Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new Error(`rating must be a whole number from 1 to 5, got ${JSON.stringify(value)}`);
    }
    mine.rating = rating;
  } else if (field === 'status') {
    mine.status = value;
  } else {
    mine.notes = value;
  }

  const next = rows.slice();
  next[index] = { ...rows[index], mine };
  return next;
}

export function removeProperty(rows: Property[], id: string): Property[] {
  if (!rows.some((row) => row.id === id)) {
    throw new Error(`no property with id ${JSON.stringify(id)}`);
  }
  return rows.filter((row) => row.id !== id);
}
