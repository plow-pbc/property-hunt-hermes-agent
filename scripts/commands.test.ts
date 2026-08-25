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

test('no script reaches a filesystem', () => {
  // The shape this repo now commits to: the Mac holds the data, this repo holds
  // the logic, and nothing here bridges them. An fs call is exactly how a second
  // copy of the state creeps back in — which is what drifted before.
  const offenders: string[] = [];
  for (const name of fs.readdirSync(SCRIPTS).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
    fs.readFileSync(path.join(SCRIPTS, name), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
        if (/\bfs\.\w+|from 'node:fs'/.test(line)) offenders.push(`${name}:${i + 1} — ${t.slice(0, 60)}`);
      });
  }
  assert.deepEqual(offenders, [], 'these still touch a filesystem');
});

test('the launchd job binds the file server to loopback only', () => {
  // Tailscale is the only way in, and it is tailnet-scoped. Binding the
  // wildcard would put the map — and the addresses of houses someone is
  // considering — on the whole LAN.
  //
  // Read the argument that FOLLOWS --bind, not any address in the file: the
  // comments explain why not to bind the wildcard, and a plain scan flags the
  // explanation. Same trap the Bearer scan fell into.
  const plist = fs.readFileSync(path.join(BUNDLE, 'references', 'launchd', 'co.plow.property-map.plist'), 'utf8');
  const args = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  const bindAt = args.indexOf('--bind');
  assert.notEqual(bindAt, -1, 'the job must bind explicitly rather than default');
  assert.equal(args[bindAt + 1], '127.0.0.1');
  // The interpreter is substituted, never hardcoded: /usr/bin/python3 is the
  // Command Line Tools shim and prompts for an install it cannot do under
  // launchd, which KeepAlive turns into a silent respawn loop.
  assert.ok(args.includes('@PYTHON@'), 'the python path is resolved on the Mac at install time');
  assert.ok(!args.includes('/usr/bin/python3'), 'and never hardcoded');
});

test('SKILL.md keeps both guards on the photo fetch', () => {
  // These two flags are the only thing between an attacker-controlled og:image
  // and a probe of the user's tailnet and LAN, because photoDirective
  // deliberately stopped doing the fetch itself. The invariant lives in prose,
  // so it is pinned here the way the harvest expression is — otherwise a
  // rewrite drops a flag and the suite stays green.
  const skill = fs.readFileSync(path.join(BUNDLE, 'SKILL.md'), 'utf8');
  const block = skill.slice(skill.indexOf('"curl"'), skill.indexOf('"curl"') + 400);
  assert.notEqual(skill.indexOf('"curl"'), -1, 'SKILL.md must show the fetch command');
  assert.match(block, /"--resolve"/, 'the vetted address must be pinned');
  assert.match(block, /"--max-redirs",\s*"0"/, 'unvetted redirect hops must be refused');
});


/**
 * Every command SKILL.md tells the agent to run, as one string per invocation.
 *
 * Assertions about what a command must or must not contain have to read this
 * rather than the whole document. Four separate contract tests here have been
 * broken by matching the prose that explains what NOT to do — the sentence
 * warning against a flag contains the flag.
 */
function skillCommands(): string[] {
  const skill = fs.readFileSync(path.join(BUNDLE, 'SKILL.md'), 'utf8');
  const out: string[] = [];
  for (const fence of skill.matchAll(/```json\n([\s\S]*?)```/g)) {
    for (const cmd of fence[1].matchAll(/"command"\s*:\s*\[([^\]]*)\]/g)) {
      out.push(cmd[1].replace(/\s+/g, ' ').trim());
    }
  }
  return out;
}

test('the map is served as a port, never as a directory', () => {
  // `tailscale serve <directory>` is refused outright by the Mac build. This
  // was pinned when the invocation lived in the justfile; the invocation moved
  // to SKILL.md and the pin has to move with it, because getting it wrong is a
  // hard error at the operator rather than a red test.
  const serve = skillCommands().find((c) => c.includes('"serve"'));
  assert.ok(serve, 'SKILL.md must show the tailnet publish');
  assert.match(serve, /"serve", "--bg", "8787"/, 'proxy a port');

  // Every element AFTER serve, not just the next one: `serve --bg 8787 <dir>`
  // satisfies the containment check above and is the realistic way to get this
  // wrong, since --bg is the form the doc uses. The binary itself is a path,
  // so only what follows the subcommand is inspected.
  const argv = serve.split(',').map((x) => x.trim().replace(/^"|"$/g, ''));
  const after = argv.slice(argv.indexOf('serve') + 1);
  assert.deepEqual(
    after.filter((x) => x.includes('/')),
    [],
    'no argument after `serve` may name a path — macOS refuses path serving',
  );
});

test('the interpreter is resolved by running it', () => {
  // `command -v python3` finds /usr/bin/python3 — the Command Line Tools shim
  // that exists, is executable, and exits non-zero under launchd. Locating it
  // succeeds in exactly the case that must fail, so the check has to run it.
  const cmds = skillCommands();
  assert.ok(
    cmds.some((c) => /python3 -c .import sys; print\(sys\.executable\)./.test(c)),
    'the interpreter must be resolved by running it',
  );
  assert.ok(
    !cmds.some((c) => /command -v python3/.test(c)),
    'locating it is not proof it runs — /usr/bin/python3 is a shim that exists and fails',
  );
});

test('the port is freed without the shell killing itself', () => {
  // `pkill -f 'http.server 8787'` matches the argv of the shell running it, so
  // the shell SIGTERMs itself and the launchctl load that follows never runs.
  const cmds = skillCommands();
  const load = cmds.find((c) => c.includes('launchctl load'));
  assert.ok(load, 'SKILL.md must show the job being loaded');
  assert.match(load, /lsof -ti :8787/, 'free the port by what holds it, not by a name pattern');
  assert.ok(!/pkill -f .http\.server/.test(load), 'that pattern matches the running shell');
});

test('the docs say the job starts at login', () => {
  // A LaunchAgent runs in the user's GUI session: it starts at login, not at
  // boot. Asserted as the presence of the correct claim rather than the
  // absence of the wrong one — a scan for "across reboots" also flags the
  // sentence explaining why not to say it, which is how the two previous
  // versions of this test failed.
  for (const name of ['SKILL.md', 'README.md']) {
    const text = fs.readFileSync(path.join(BUNDLE, name), 'utf8');
    assert.match(text, /at login/i, `${name} must say when the job actually starts`);
  }
});
