import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Three review rounds went to the same defect wearing different masks: a
// user-facing string that names one of these scripts but isn't runnable as
// written (missing `node`) or quotes a value in a way an apostrophe breaks.
// Fixing each site as it was cited just relocated the bug. This pins the
// invariant instead, so the class can't come back.

const SCRIPTS = fileURLToPath(new URL('.', import.meta.url));
const BUNDLE = path.dirname(SCRIPTS);

const SOURCES: Array<{ name: string; text: string }> = fs
  .readdirSync(SCRIPTS)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .map((name) => ({ name, text: fs.readFileSync(path.join(SCRIPTS, name), 'utf8') }));

// SKILL.md is where the agent copies commands FROM, and where this whole class
// of bug started — excluding it would leave the invariant claiming more than it
// checks. Only fenced shell blocks count; the prose around them names the
// scripts constantly and is not copied verbatim.
for (const doc of ['SKILL.md', 'README.md']) {
  const full = path.join(BUNDLE, doc);
  if (!fs.existsSync(full)) continue;
  const fenced = [...fs.readFileSync(full, 'utf8').matchAll(/```(?:sh|bash)\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .join('\n');
  SOURCES.push({ name: doc, text: fenced });
}

/** Lines that are pure comment carry prose, not instructions a user copies. */
function instructionLines(text: string): Array<{ n: number; line: string }> {
  return text
    .split('\n')
    .map((line, i) => ({ n: i + 1, line }))
    .filter(({ line }) => !/^\s*(\/\/|\*|\/\*|#)/.test(line));
}

test('every command we print is runnable as printed', () => {
  const offenders: string[] = [];
  for (const { name, text } of SOURCES) {
    for (const { n, line } of instructionLines(text)) {
      // An import specifier names a module, not a command.
      if (/\bfrom\s+['"]/.test(line)) continue;
      for (const match of line.matchAll(/(?:properties|scrape)\.ts\b/g)) {
        // Runnable means `node` invokes it — with an optional path in between,
        // since the skill calls these by absolute path inside the agent VM.
        const before = line.slice(0, match.index);
        if (!/\bnode\s+\S*$/.test(before)) {
          offenders.push(`${name}:${n} — "${line.trim()}"`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `these name a script without "node ", so they don't run as printed`);
});

test('no printed command single-quotes a value an apostrophe would break', () => {
  // `--scraped '<json>'` was the original sin: a scraped record carries an
  // address, and 1200 O'Farrell St is an ordinary San Francisco one.
  const offenders: string[] = [];
  for (const { name, text } of SOURCES) {
    for (const { n, line } of instructionLines(text)) {
      if (/--scraped\s+'/.test(line)) offenders.push(`${name}:${n} — "${line.trim()}"`);
    }
  }
  assert.deepEqual(offenders, [], 'single-quoted JSON breaks on any address containing an apostrophe');
});
