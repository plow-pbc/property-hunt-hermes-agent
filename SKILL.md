---
name: property-hunt
description: Track houses for sale on a private map. Use when the user texts a photo or screenshot of a property listing, pastes a listing URL, asks to add or remove a property, wants to rate one, leave notes on one, mark it toured or passed, refresh its price, or asks which houses they have saved. Looks the listing up in the browser on the user's Mac, keeps everything in ~/Plow/properties, and renders a map with photo pins.
---

# Track houses for sale on a private map

The user is house hunting. They text you photos of listings; you identify each
one, look up what the photo doesn't show, and keep a private map they can open
from their Mac or their phone.

## How this works, and why it matters

**You hold the logic. The Mac holds the data.** The scripts run here, in your
container, from a pinned checkout. `~/Plow/properties/` on the Mac holds
`data.js`, the map, and the photos — and nothing else. There is no copy of
these scripts on the Mac to fall out of step with you.

So every change to the store is three moves:

1. **Read** `~/Plow/properties/data.js` with `plow_read_file`
2. **Transform** it by running a script here, passing the contents as `--store`
3. **Write** the result back with `plow_write_file`

The scripts never touch a filesystem. They take the store as an argument and
print a JSON envelope saying what should replace it:

```json
{ "store": "…", "fetch": {…}, "remove": ["…"], "id": "…", "verb": "added", "notes": ["…"] }
```

`store` is the exact text to write back. `fetch` and `remove` appear only when
there is something to do on the Mac. **A key that is absent means nothing to
do** — do not invent an empty one.

## Requirements

Plow Latch, which is how you reach the Mac. You need `plow_browser_open`,
`plow_browser`, `plow_read_file`, `plow_write_file` and `plow_run_command`.

Serving the map to a phone additionally needs a working `python3` and Tailscale
on the Mac. Both are checked in that section before anything is installed, so
nothing else here depends on them.

`plow_run_command` takes an **argv array and runs it directly — there is no
shell**. `~` is never expanded, so use the real absolute path. Values are
separate array elements; never build one string out of them.

## First time only

Create the folder and put the map there. `index.html` and the Leaflet files are
text, so you write them yourself — read each from your own checkout and write
it across.

```json
{
  "command": ["mkdir", "-p", "/Users/<user>/Plow/properties/photos", "/Users/<user>/Plow/properties/vendor"]
}
```

Then `plow_write_file` each of these, from `references/frontend/` in your
checkout to `~/Plow/properties/`:

| from | to |
|---|---|
| `references/frontend/index.html` | `~/Plow/properties/index.html` |
| `references/frontend/vendor/leaflet.js` | `~/Plow/properties/vendor/leaflet.js` |
| `references/frontend/vendor/leaflet.css` | `~/Plow/properties/vendor/leaflet.css` |

The marker PNGs in `references/frontend/vendor/images/` are **not** copied. The
map draws its own pins from the property photos, so Leaflet never asks for
them.

Finally the store — **only if there is not one already.** Check first:

```json
{ "tool": "plow_read_file", "path": "/Users/<user>/Plow/properties/data.js" }
```

If that succeeds, stop: the user has properties and this file is all of them.
Writing an empty store over it erases every house they have saved, and nothing
here can get them back. Only when the read fails:

```json
{ "path": "/Users/<user>/Plow/properties/data.js", "content": "window.PROPERTIES =\n[]\n" }
```

## Adding a property

A texted photo arrives as a file path. **Read the image** — you need the
address.

**1. Get the listing URL.** If the user pasted one, or one is legible in the
screenshot, use it. Otherwise search for the address on Compass — that is the
default source. Any listing site works; prefer Compass only when *you* are
choosing.

**2. Open a browser session for that site.** Include the apex and the wildcard.
The owner approves this list, so asking for both at once avoids a second prompt
mid-conversation.

```json
{ "tool": "plow_browser_open", "origins": ["compass.com", "*.compass.com"], "goal": "Read a property listing the user is considering" }
```

**3. Load the page.**

```json
{ "tool": "plow_browser", "session": "<session>", "action": "goto", "url": "<listing-url>" }
```

**4. Read the listing.** Use this expression exactly as written. It polls inside
the page, because `goto` returns while a listing is still an empty shell and
reading that shell looks the same as being blocked:

```js
(async () => { const read = () => ({ jsonld: [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => s.textContent), og: Object.fromEntries([...document.querySelectorAll('meta[property^="og:"], meta[name^="twitter:"]')].map(m => [m.getAttribute('property') || m.getAttribute('name'), m.content || ''])) }); const deadline = Date.now() + 10000; let seen = read(); while (Date.now() < deadline) { if (seen.jsonld.length && Object.keys(seen.og).length) return { ...seen, settled: true }; await new Promise(r => setTimeout(r, 750)); seen = read(); } return { ...seen, settled: false }; })()
```

Pass it as the `expression` field of a `plow_browser` `eval`. It returns
`{ jsonld, og, settled }` — hand the whole thing to the next step unedited.

**5. Read the current store.**

```json
{ "tool": "plow_read_file", "path": "/Users/<user>/Plow/properties/data.js" }
```

**6. Transform it — here, in your own container.**

Write one request file, then pass its path:

```json
{
  "harvest": "<the eval result, as a string>",
  "url": "<listing-url>",
  "store": "<the data.js contents>",
  "photoOnDisk": false
}
```

```sh
node scripts/scrape.ts --request /tmp/request.json
```

**Nothing goes in as a shell word.** The harvest payload is a listing page's
own JSON-LD, the store holds the user's notes, and the URL was pasted — any of
them can contain an apostrophe that ends a quote and turns the rest into
command syntax in your own container. The URL cannot be validated first
either: by then the shell has already parsed it. A path you chose is the only
value here that is yours.

Set `photoOnDisk` to `true` only when refreshing a property whose photo file is
already on the Mac.

Add `--photo-on-disk` when you are refreshing a property whose photo file is
already on the Mac. Leaving it off costs a re-fetch; claiming it wrongly leaves
a pin pointing at nothing.

**7. Fetch the photo first, if the envelope carried a `fetch`.**

```json
{
  "command": ["/bin/sh", "-c", "curl --resolve \"$1\" --max-redirs 0 --max-filesize 20000000 -fsSL -o \"$2.part\" \"$3\" && mv \"$2.part\" \"$2\"", "sh", "<fetch.resolve>", "<fetch.path>", "<fetch.url>"],
  "cwd": "/Users/<user>/Plow/properties",
  "network": true,
  "writes": ["/Users/<user>/Plow/properties/photos"]
}
```

The values go in as **separate argv elements** and are referenced as `$1 $2 $3`,
never pasted into the command string — the URL comes from the listing page.

Three things beyond the two flags. It downloads to `.part` and moves only on
success, so an interrupted transfer cannot leave a truncated image or destroy
the previous good one. `--max-filesize 20000000` caps what a listing can put on
the user's disk. And `-f` makes an HTTP error a failure rather than a saved
error page.

**Both flags are required, and neither is stylistic.** The photo URL comes from
the listing page, so it is not the user's text and not yours. `--resolve` pins
the address that was already vetted, so DNS cannot swing to a private one
between the check and the fetch. `--max-redirs 0` refuses hops nobody vetted —
the transform already followed them and gave you the final URL. Dropping either
turns the map into a probe of the user's own network.

**8. Write the store that matches what happened.**

| the fetch | write |
|---|---|
| succeeded, or there was no `fetch` | `store` |
| failed | `store_without_photo` |

```json
{ "tool": "plow_write_file", "path": "/Users/<user>/Plow/properties/data.js", "content": "<the one you chose>" }
```

Fetching before writing is deliberate. `store` names the photo file, so writing
it after a failed fetch leaves a record pointing at nothing — the map draws
that as a broken image, and no later refresh clears it, because the photo field
is no longer null and the carry-forward never fires. `store_without_photo` is
the same listing with an honest empty photo; a plain marker beats a broken one,
and the next refresh will try the photo again.

**9. Tell the user what you saved** — one line: address, price, beds/baths/sqft.

### When it fails

A failure prints `{"type":"tool_error","error":"..."}` and no `store`, so there
is nothing to write back.

**If the error carries `"retryable": true`**, the page had not finished
rendering. Repeat steps 4 through 6 — up to three attempts. Do not reload the
page and do not open a second session; the expression polls on its own, so each
attempt gives the page another ten seconds.

**Any other error is final.** Read it and tell the user plainly. When it says
the page does not publish a field, try the same property on another listing
site. Never supply a value you could not measure.

## Editing

Read the store, transform, write it back — the same three moves.

One request file again — the user's own notes are in the store, and a note is
whatever they typed:

```json
{ "verb": "list", "json": true,  "store": "<contents>" }
{ "verb": "get",  "id": "<id>",  "store": "<contents>" }
{ "verb": "set",  "id": "<id>", "field": "rating", "value": "4", "store": "<contents>" }
{ "verb": "set",  "id": "<id>", "field": "status", "value": "toured", "store": "<contents>" }
{ "verb": "set",  "id": "<id>", "field": "notes", "value": "needs a new roof", "store": "<contents>" }
{ "verb": "rm",   "id": "<id>",  "store": "<contents>" }
```

```sh
node scripts/properties.ts --request /tmp/request.json
```

`list` and `get` only read, so there is nothing to write back. `set` and `rm`
print an envelope; write its `store`.

`rm` also carries `remove` with the photo to delete. It does not delete
anything itself:

```json
{ "command": ["rm", "-f", "<each entry in remove>"], "cwd": "/Users/<user>/Plow/properties" }
```

`status` is free text; `new`, `interested`, `toured`, and `passed` are the ones
the map colours. `rating` is 1–5.

The user's words go into the request file as a JSON value, exactly as they said
them. An apostrophe, a quote, a backtick, a semicolon — none of it is ever
parsed as a shell word.

Match loosely and confirm: *"the one on Elm"* means read `list --json` and find
it. If two could match, ask which.

**To refresh a listing** (price cut, went pending), add it again with the same
steps. It updates in place and **never touches the user's rating, notes, or
status.**

## Answering questions

Read `list --json` and answer from it. There is no query language and you do not
need one — a house hunt is a few dozen properties.

## The map

`~/Plow/properties/index.html`. The user opens it from Finder. Each pin is the
house's photo with its price and bed count, ringed by status; clicking one opens
the listing.

### Serving it to a phone

The map is a file on the Mac, so a phone cannot open it directly. Put it on the
user's tailnet — private, HTTPS, never the public internet.

There is no checkout on the Mac, so you do this yourself rather than running a
recipe there. It needs a working `python3` and Tailscale on the Mac; both are
checked below before anything is installed.

**1. Check there is a map to serve.**

```json
{ "tool": "plow_read_file", "path": "/Users/<user>/Plow/properties/data.js" }
```

If that fails there is nothing to serve yet — the folder is created on the
first save. Tell the user to add a house first and stop here.

**2. Resolve the interpreter by RUNNING it, not by locating it.**

```json
{ "command": ["/bin/sh", "-lc", "python3 -c 'import sys; print(sys.executable)'"] }
```

`command -v python3` is not good enough. On a Mac without Command Line Tools,
`/usr/bin/python3` exists and is executable but is a shim that prompts for an
install — under launchd that is a non-zero exit into a respawn loop, and the
map goes blank while everything looks configured. Running it proves it works.
**If this exits non-zero, stop** and tell the user to install Python or the
Command Line Tools. Do not write a plist naming an interpreter that never ran.

**3. Find Tailscale**, which may be the app bundle or the open-source CLI:

```json
{ "command": ["/bin/sh", "-lc", "command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale"] }
```

**4. Write the launchd job.** Read
`references/launchd/co.plow.property-map.plist` from your own checkout,
substitute `@PYTHON@` with step 2's output, `@PORT@` with `8787`, and `@DIR@`
with `/Users/<user>/Plow/properties`, then:

```json
{ "path": "/Users/<user>/Library/LaunchAgents/co.plow.property-map.plist", "content": "<the substituted plist>" }
```

**5. Load it.** Unload first so a re-run replaces the definition, and free the
port of anything that is not launchd — a second server would lose the bind and
`KeepAlive` would respawn it forever:

```json
{ "command": ["/bin/sh", "-lc", "launchctl unload ~/Library/LaunchAgents/co.plow.property-map.plist 2>/dev/null; lsof -ti :8787 | xargs -r kill; launchctl load ~/Library/LaunchAgents/co.plow.property-map.plist"] }
```

Use `lsof`, not `pkill -f 'http.server 8787'`. That pattern matches the argv of
the shell running it, so the shell kills itself and `launchctl load` never
runs — and the failure only surfaces at the next step as an unexplained curl
error.

**6. Check that what answers is the map**, not some other service that happened
to hold the port. 8787 is not reserved, and publishing a stranger's service to
the tailnet is worse than failing:

```json
{ "command": ["/bin/sh", "-lc", "curl -fsS http://127.0.0.1:8787/data.js | head -c 40"], "network": true }
```

It must print `window.PROPERTIES =`. If it does not, stop — do not continue.

**7. Publish it to the tailnet**, using the path step 3 printed:

```json
{ "command": ["<tailscale>", "serve", "--bg", "8787"], "network": true }
```

Then `serve status` prints the URL. Tell the user that one.

Serve a **port**, never a directory. `tailscale serve <directory>` is refused
outright by the Mac build — "Path serving is not supported on macOS due to
sandbox restrictions" — which is why there is a file server to proxy at all.

The job starts **at login** and stops at logout. It does not start at boot
before anyone has logged in, so after a restart the map returns once the user
logs in — tell them that rather than promising it comes back on its own.

## Rules

- **The scripts are the only thing that shapes the store.** Never write
  `data.js` from your own reasoning — run the transform and write what it
  printed. It enforces the dedup key, the field rules, and the separation
  below; you would be guessing at all three.
- **`scraped` is the listing's; `mine` is the user's.** You cannot `set` a
  scraped field — those only come from a scrape, so their timestamp stays
  honest.
- **Never invent a value.** If the scrape did not find the price, it is `null`.
  Say you could not find it.
- **Always pass `--store`.** Every command refuses without it rather than
  assuming an empty store, because assuming would discard every property on the
  write that follows.
- A property with no coordinates still gets saved; the map lists it under
  *"not on the map"* rather than dropping it.

## Checking your own work

```sh
node --test scripts/commands.test.ts scripts/extract.test.ts scripts/properties.test.ts scripts/scrape.test.ts scripts/store.test.ts
```
