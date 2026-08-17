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
const SOURCES = fs
  .readdirSync(SCRIPTS)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));

/** Lines that are pure comment carry prose, not instructions a user copies. */
function instructionLines(text: string): Array<{ n: number; line: string }> {
  return text
    .split('\n')
    .map((line, i) => ({ n: i + 1, line }))
    .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line));
}

test('every command we print is runnable as printed', () => {
  const offenders: string[] = [];
  for (const name of SOURCES) {
    const text = fs.readFileSync(path.join(SCRIPTS, name), 'utf8');
    for (const { n, line } of instructionLines(text)) {
      // An import specifier names a module, not a command.
      if (/\bfrom\s+['"]/.test(line)) continue;
      for (const match of line.matchAll(/(\S*\s*)((?:properties|scrape)\.ts)\b/g)) {
        const [, before] = match;
        if (!/node\s+$/.test(before)) {
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
  for (const name of SOURCES) {
    const text = fs.readFileSync(path.join(SCRIPTS, name), 'utf8');
    for (const { n, line } of instructionLines(text)) {
      if (/--scraped\s+'/.test(line)) offenders.push(`${name}:${n} — "${line.trim()}"`);
    }
  }
  assert.deepEqual(offenders, [], 'single-quoted JSON breaks on any address containing an apostrophe');
});
