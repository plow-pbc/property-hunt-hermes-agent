# Review instructions — property-hunt-hermes-agent

Repo-specific reviewer policy. The universal voice posture (Broken-Glass,
pro-simplification, and the don't-propose list) is supplied by the reviewers
themselves and is deliberately not restated here.

## Operating point

Pre-PMF, two people, each with their own registry row against one checkout on a
single Linux host, each driving their own Mac. Iteration speed beats hardening
for scale: prefer loud failures to fallbacks, and don't guard a case two users
cannot reach.

One thing is **not** on that sliding scale, and it is the axis that decides most
findings here: **the store is irreplaceable.** `~/Plow/properties/data.js` is
the user's own house hunt — addresses they are considering, private notes,
ratings — and nothing in this system can reconstruct it. So the usual pre-PMF
tolerance for a lossy shortcut does not apply to anything that writes, serves,
or transmits that file. `parseStore` throwing on a malformed store is the design
working, not a missing fallback; a "recovery" that returns an empty store on a
bad read is the single worst change that could land here.

## What this repo is

**One repo carrying both halves of an agent** — the skill and the deployment
that installs it. `README.md` owns the layer contract, the deploy recipe, and
what does and does not enter the container; this file does not restate them.
Flag drift between that prose and the code, in either direction.

**Stage:** prototype, not shipped, no dates. Two house hunts.

**Execution model:** the scripts run in the agent's container, out of a
**read-only** mount of `skill/`. Node 24 runs the TypeScript directly — no
build, no dependencies, and that is a deliberate constraint rather than an
unfinished one. The Mac holds only Latch and the user's data; there is no copy
of these scripts on it to fall out of step.

**Trust boundary (known and accepted):** this agent reads attacker-controlled
input by design — a listing page's own JSON-LD, a pasted URL, a texted
screenshot — while holding a Latch credential that drives the user's Mac. That
is why only `skill/` is mounted, why nothing untrusted may become a shell word,
and why the mount is read-only. Latch authorises each action on the Mac, so the
approval surface stays there.

**The frontend is deployed by copy.** `references/frontend/` is the source;
`~/Plow/properties/index.html` and `vendor/` are deployed artifacts of it. They
are outputs, not files anyone edits in place.

## Review priority

Subtractive remedies outrank additive ones. The falsifiable gate for this repo
is **what reaches the store or the Mac**: a value that becomes a shell word, a
path that leaves its directory, a write that skips the scripts, a store that
leaves the machine, or a deployed artifact that diverges from its source.

Three things are deliberately **not** violations and flagging them is a false
finding: the absence of a build step or dependency manifest (Node runs the TS
directly, on purpose); bundled Leaflet under `references/frontend/vendor/`
(vendored so the map has no third party and works offline — a CDN suggestion
inverts the privacy design); and real-looking addresses in test fixtures, which
are public listing data chosen so the round-trip tests are load-bearing.

The failure class this skill exists to prevent is **a house hunt silently
losing entries** — a store overwritten, reset, or frozen so the map stops
tracking it. Anything that reopens that path is blocking.

**Repo-specific contrast pairs:**

| property-hunt DON'T (suppress / flag-as-shape) | property-hunt DO (real finding) |
|---|---|
| Ask for a `try`/`catch` around a store read, or a fallback to an empty store. Throwing is the design — the store is irreplaceable and a silent reset destroys a house hunt no backup covers. | Flag a path that **writes the store without going through the scripts**, or an envelope key invented when it was absent. `store` is the exact text to write back; a hand-assembled one is how a field gets dropped from every row at once. One path is exempt: first-run seeding of an empty store *after* the existence check fails (`SKILL.md` § First time only). Exempt rather than exemplary — it hand-types the file format a second time, so seeding from `emptyStoreText()` would retire the exemption along with the drift. |
| Ask for auth on the map's file server. It is loopback-bound and the user is the only principal on that machine. | Flag the store becoming **readable by a page the user did not open**. It is served as an executable script, so a cross-origin `<script src>` reads addresses and notes out of the including page's window — loopback binding stops the network, not the user's own browser. |
| Propose a bundler, a dependency manifest, or a CDN for Leaflet. No build and no third party are both deliberate. | Flag a **new runtime dependency** reaching the container or the Mac. The mount is read-only and the Mac holds no copy of this code; anything that needs installing on either side breaks the property that they cannot drift. |
| Ask a test to pin a photo filename or a slug's exact spelling beyond the cases already covered. | Flag a **path that can leave its directory**. Photos are joined onto `photos/` and the store onto the properties folder; a traversing component aims a write at the user's home. Reject by component, not substring. |
| Treat doc-only edits as low-value churn. | Flag **prose↔code drift, in every copy**. The user-facing contract is stated in `README.md` *and* `skill/SKILL.md`; a change that fixes one and leaves the other is the canonical regression here, and the stale copy is the one users actually follow. |
| — | Flag **any untrusted value reaching a shell word**. The harvest payload, the store, and the URL are all attacker-influenced, and `plow_run_command` takes argv precisely so none of them is parsed. A value pasted into a command string is blocking however it is quoted. |
| — | Flag an instruction that lets the agent **edit a deployed frontend artifact in place**. `index.html` and `vendor/` are copies of `references/frontend/`; patching them on the Mac makes the page stop tracking the store — the map freezes at whatever was inlined — and the next deploy silently reverts the fix while the cause remains. The remedy for a wrong artifact is to re-copy it. |
| — | Flag a **verification that reads bytes instead of the artifact**. A byte count, a `grep`, or a file that grew proves a write landed and says nothing about whether the map renders. The agent holds `plow_browser_open` and `plow_browser`; a claim that the map works is only evidence when it comes from rendering the served URL. |
| — | Flag a change that sends the store **anywhere new**. `README.md` enumerates exactly what leaves the machine and to whom; a fifth destination is a product decision, not an implementation detail, and it belongs in that list before it belongs in code. |

**Update cadence:** edit when the stage changes — more users than a handful, a
second host, or a distribution story that is not a git clone. Product and
architecture edits belong in `README.md`, not here.
