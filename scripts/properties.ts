#!/usr/bin/env node
// The store CLI, as a pure transform. Every command takes the store's text and
// prints what should replace it; nothing here reads or writes a file.
//
// The store lives on the operator's Mac and this runs in the agent's container,
// so the agent is the transport: it reads data.js through Latch, runs one of
// these, and writes the result back. Keeping the logic in one pinned place is
// the point — a second copy on the Mac is what drifted before.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { loadStore, removeProperty, serializeStore, setMine, MINE_FIELDS } from './store.ts';
import type { Property } from './store.ts';

/** What the agent has to do on the Mac after a transform. */
export type Fetch = { url: string; resolve: string; path: string };

export type Envelope = {
  store?: string;
  /**
   * What to write when a `fetch` fails. Present only alongside one.
   *
   * The transform cannot know whether the agent's curl will succeed, and the
   * store is written before it runs — so without this a hotlink-blocking CDN
   * or a 302 (which --max-redirs 0 refuses) leaves a record pointing at a file
   * that never arrived. The map renders that as a broken image, which is the
   * outcome keepPreviousEnrichment exists to avoid, and it is unrecoverable:
   * on the next refresh the photo field is non-null, so the carry-forward
   * branch never fires and nothing ever nulls it.
   */
  store_without_photo?: string;
  fetch?: Fetch;
  remove?: string[];
  id?: string;
  verb?: string;
  notes?: string[];
};

/**
 * One envelope per mutating command, on stdout. Absent keys mean "nothing to
 * do" rather than an empty value, so the agent branches on presence.
 */
export function envelope(e: Envelope): string {
  return `${JSON.stringify(e)}\n`;
}

/**
 * The store text, from `--store`. Absent is fatal, deliberately: defaulting to
 * an empty store would print a valid-looking envelope whose write discards
 * every property the operator has.
 */
/**
 * One request file, and nothing else.
 *
 * Every value these scripts handle is untrusted: the harvest payload IS a
 * listing page's JSON-LD, the store holds the user's own notes, the listing
 * URL is pasted, and a note is whatever they typed. Any of them inside shell
 * source lets an apostrophe end the quote and the rest become command syntax
 * in the agent's container — and a URL cannot be validated first, because the
 * shell has already parsed it by then.
 *
 * So none of them are arguments. The agent writes one JSON file and passes its
 * path, which is a value it chose itself.
 */
export type Request = {
  store: string;
  verb?: string;
  id?: string;
  field?: string;
  value?: string;
  json?: boolean;
  harvest?: string;
  url?: string;
  photoOnDisk?: boolean;
};

export function takeRequest(argv: string[], read = (p: string) => readFileSync(p, 'utf8')): Request {
  const at = argv.indexOf('--request');
  if (at === -1 || argv[at + 1] === undefined) {
    throw new Error(`missing --request <path to a JSON request>\n\n${USAGE}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read(argv[at + 1]));
  } catch (err) {
    throw new Error(`could not read the request at ${argv[at + 1]}: ${(err as Error).message}`);
  }
  const req = parsed as Request;
  if (typeof req?.store !== 'string') {
    throw new Error('the request needs a "store" string — the contents of data.js');
  }
  return req;
}

const USAGE = `property-hunt store — one JSON request file, no other arguments

  node properties.ts --request <path>

The file holds everything, because every value here is untrusted — the store
carries the user's notes, and a note is whatever they typed:

  { "verb": "list", "json": true,        "store": "<contents of data.js>" }
  { "verb": "get",  "id": "<id>",        "store": "…" }
  { "verb": "set",  "id": "<id>", "field": "${MINE_FIELDS.join('|')}", "value": "…", "store": "…" }
  { "verb": "rm",   "id": "<id>",        "store": "…" }

Nothing is passed as a shell word, so no apostrophe or metacharacter in a note,
an id, or the store can become command syntax. Adding and refreshing a property
is a separate command — see SKILL.md.

list and get print their output. set and rm print a JSON envelope: the new
store, plus anything the agent must do on the Mac.`;

function requireArg(value: string | undefined, name: string): string {
  if (value === undefined || value === '') throw new Error(`missing <${name}>\n\n${USAGE}`);
  return value;
}

function findOrThrow(rows: Property[], id: string): Property {
  const row = rows.find((candidate) => candidate.id === id);
  if (!row) {
    const known = rows.map((r) => r.id).join('\n  ') || '(store is empty)';
    throw new Error(`no property with id ${JSON.stringify(id)}. Known ids:\n  ${known}`);
  }
  return row;
}

function summarize(row: Property): string {
  const s = row.scraped;
  const money = s.price === null ? '?' : `$${s.price.toLocaleString('en-US')}`;
  const facts = [s.beds && `${s.beds}bd`, s.baths && `${s.baths}ba`, s.sqft && `${s.sqft}sqft`]
    .filter(Boolean)
    .join(' · ');
  const stars = row.mine.rating === null ? '' : ` ${'★'.repeat(row.mine.rating)}`;
  const note = row.mine.notes ? ` — ${row.mine.notes}` : '';
  return `${row.id}\n  ${s.address}, ${s.city} ${s.state}  ${money}  ${facts}\n  [${row.mine.status}]${stars}${note}`;
}

function main(argv: string[]): void {
  if (argv[0] === '--help' || argv[0] === '-h' || argv.length === 0) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const req = takeRequest(argv);
  const rows = loadStore(req.store);
  const verb = req.verb;

  switch (verb) {
    case 'list': {
      if (req.json) {
        process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      } else if (rows.length === 0) {
        process.stdout.write('no properties yet\n');
      } else {
        const label = rows.length === 1 ? 'property' : 'properties';
        process.stdout.write(`${rows.map(summarize).join('\n\n')}\n\n${rows.length} ${label}\n`);
      }
      return;
    }
    case 'get': {
      process.stdout.write(`${JSON.stringify(findOrThrow(rows, requireArg(req.id, 'id')), null, 2)}\n`);
      return;
    }
    case 'set': {
      const id = requireArg(req.id, 'id');
      findOrThrow(rows, id);
      const field = requireArg(req.field, 'field');
      const value = req.value ?? '';
      process.stdout.write(
        envelope({
          store: serializeStore(setMine(rows, id, field, value)),
          id,
          verb: 'updated',
          notes: [`${field} = ${JSON.stringify(value)}`],
        }),
      );
      return;
    }
    case 'rm': {
      const id = requireArg(req.id, 'id');
      const row = findOrThrow(rows, id);
      process.stdout.write(
        envelope({
          store: serializeStore(removeProperty(rows, id)),
          id,
          verb: 'removed',
          // Named, never deleted here. Nothing in this process reaches the Mac.
          ...(row.scraped.photo ? { remove: [row.scraped.photo] } : {}),
        }),
      );
      return;
    }
    default:
      throw new Error(`unknown verb ${JSON.stringify(verb)}\n\n${USAGE}`);
  }
}

// Only run when invoked directly, so tests can import resolveDataDir.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }
}
