#!/usr/bin/env node
// The store CLI, as a pure transform. Every command takes the store's text and
// prints what should replace it; nothing here reads or writes a file.
//
// The store lives on the operator's Mac and this runs in the agent's container,
// so the agent is the transport: it reads data.js through Latch, runs one of
// these, and writes the result back. Keeping the logic in one pinned place is
// the point — a second copy on the Mac is what drifted before.
import { pathToFileURL } from 'node:url';

import { loadStore, removeProperty, serializeStore, setMine, MINE_FIELDS } from './store.ts';
import type { Property } from './store.ts';

/** What the agent has to do on the Mac after a transform. */
export type Fetch = { url: string; resolve: string; path: string };

export type Envelope = {
  store?: string;
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
export function takeStore(argv: string[]): { rest: string[]; text: string } {
  const at = argv.indexOf('--store');
  if (at === -1 || argv[at + 1] === undefined) {
    throw new Error(`missing --store <contents of data.js>\n\n${USAGE}`);
  }
  return { rest: [...argv.slice(0, at), ...argv.slice(at + 2)], text: argv[at + 1] };
}

const USAGE = `property-hunt store — every command takes --store

  list [--json]   --store <data.js>          every property
  get <id>        --store <data.js>          one property as JSON
  set <id> <field> <value> --store <data.js> ${MINE_FIELDS.join(' | ')}
  rm <id>         --store <data.js>          drop it, and name its photo

Adding and refreshing a property is a separate command — see SKILL.md.

--store takes the CONTENTS of data.js, not a path. Mutating commands print a
JSON envelope: the new store, plus anything the agent must do on the Mac.

Values are passed as separate arguments, never concatenated into one string, so
an apostrophe in a note needs no escaping.`;

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
  const [verb] = argv;
  if (!verb || verb === '--help' || verb === '-h') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const { rest: all, text } = takeStore(argv);
  const rows = loadStore(text);
  const rest = all.slice(1);

  switch (verb) {
    case 'list': {
      if (rest.includes('--json')) {
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
      process.stdout.write(`${JSON.stringify(findOrThrow(rows, requireArg(rest[0], 'id')), null, 2)}\n`);
      return;
    }
    case 'set': {
      const id = requireArg(rest[0], 'id');
      // Through findOrThrow so an unknown id lists the ones that exist, the
      // same as rm. The agent matches loosely — "the one on Elm" — so the ids
      // it can choose from are the useful half of the error.
      findOrThrow(rows, id);
      const field = requireArg(rest[1], 'field');
      const value = rest.slice(2).join(' ');
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
      const id = requireArg(rest[0], 'id');
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
