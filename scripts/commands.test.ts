import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HARVEST_EXPRESSION } from './scrape.ts';

// Several review rounds went to one defect: a user-facing string naming one of
// these scripts that isn't runnable as printed. Fixing each site as it was
// cited just relocated it, so the invariant is pinned here instead.

const SCRIPTS = fileURLToPath(new URL('.', import.meta.url));
const BUNDLE = path.dirname(SCRIPTS);

const SOURCES: Array<{ name: string; text: string; lineOffset?: number }> = fs
  .readdirSync(SCRIPTS)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .map((name) => ({ name, text: fs.readFileSync(path.join(SCRIPTS, name), 'utf8') }));

// SKILL.md is where the agent copies commands FROM, and where this whole class
// of bug started — excluding it would leave the invariant claiming more than it
// checks. Only fenced shell blocks count; the prose around them names the
// scripts constantly and is not copied verbatim.
//
// Each fence is its own entry carrying its offset in the file: joining them
// into one blob makes every reported line number wrong, and the report exists
// solely to point at the site.
for (const doc of ['SKILL.md', 'README.md']) {
  const full = path.join(BUNDLE, doc);
  if (!fs.existsSync(full)) continue;
  const text = fs.readFileSync(full, 'utf8');
  for (const fence of text.matchAll(/```(?:sh|bash)\n([\s\S]*?)```/g)) {
    SOURCES.push({
      name: doc,
      text: fence[1],
      lineOffset: text.slice(0, fence.index).split('\n').length,
    });
  }
}

// The map page is shipped to users, so a command printed in its UI is as
// user-facing as one in SKILL.md — and it was the one surface still carrying a
// live violation while the scan looked elsewhere.
SOURCES.push({
  name: 'references/frontend/index.html',
  text: fs.readFileSync(path.join(BUNDLE, 'references', 'frontend', 'index.html'), 'utf8'),
});

/** Lines that are pure comment carry prose, not instructions a user copies. */
function instructionLines(text: string): Array<{ n: number; line: string }> {
  return text
    .split('\n')
    .map((line, i) => ({ n: i + 1, line }))
    .filter(({ line }) => !/^\s*(\/\/|\*|\/\*|#)/.test(line));
}

test('every command we print is runnable as printed', () => {
  const offenders: string[] = [];
  for (const { name, text, lineOffset = 0 } of SOURCES) {
    for (const { n, line } of instructionLines(text)) {
      // An import specifier names a module, not a command.
      if (/\bfrom\s+['"]/.test(line)) continue;
      for (const match of line.matchAll(/(?:properties|scrape)\.ts\b/g)) {
        // Runnable means `node` invokes it — with an optional path in between,
        // since the skill calls these by absolute path inside the agent VM.
        const before = line.slice(0, match.index);
        if (!/\bnode\s+\S*$/.test(before)) {
          offenders.push(`${name}:${n + lineOffset} — "${line.trim()}"`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `these name a script without "node ", so they don't run as printed`);
});

test('SKILL.md carries the harvest expression byte-identically', () => {
  // Three copies of this string exist: the constant, SKILL.md, and the howto
  // page in plow-pbc/howto. Only the first two are checkable from here, and
  // drift between them is a scrape that fails at the user rather than at CI —
  // the agent would paste an expression whose shape extractScraped no longer
  // reads.
  const skill = fs.readFileSync(path.join(BUNDLE, 'SKILL.md'), 'utf8');
  assert.ok(
    skill.includes(HARVEST_EXPRESSION),
    'SKILL.md must contain the exact HARVEST_EXPRESSION exported by scrape.ts',
  );
});

test('no doc still tells the agent to escape a shell', () => {
  // Under plow_run_command values are argv elements. Advice to wrap them in
  // single quotes and replace ' with \'\\\'\' would make every note arrive
  // with literal backslashes in it.
  for (const doc of ['SKILL.md', 'README.md']) {
    const text = fs.readFileSync(path.join(BUNDLE, doc), 'utf8');
    assert.doesNotMatch(text, /single-quote/i, `${doc} still teaches shell quoting`);
    assert.doesNotMatch(text, /\\'\\\\'\\'/, `${doc} still carries the escape recipe`);
  }
});
