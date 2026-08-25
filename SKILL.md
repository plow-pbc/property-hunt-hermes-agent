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

Finally write an empty store, once:

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

```sh
node scripts/scrape.ts --harvest '<the eval result>' '<listing-url>' --store '<the data.js contents>'
```

Add `--photo-on-disk` when you are refreshing a property whose photo file is
already on the Mac. Leaving it off costs a re-fetch; claiming it wrongly leaves
a pin pointing at nothing.

**7. Write the store back.**

```json
{ "tool": "plow_write_file", "path": "/Users/<user>/Plow/properties/data.js", "content": "<the envelope's store value>" }
```

**8. Fetch the photo, if the envelope carried a `fetch`.**

```json
{
  "command": ["curl", "--resolve", "<fetch.resolve>", "--max-redirs", "0", "-fsSL", "-o", "<fetch.path>", "<fetch.url>"],
  "cwd": "/Users/<user>/Plow/properties",
  "network": true,
  "writes": ["/Users/<user>/Plow/properties/photos"]
}
```

**Both flags are required, and neither is stylistic.** The photo URL comes from
the listing page, so it is not the user's text and not yours. `--resolve` pins
the address that was already vetted, so DNS cannot swing to a private one
between the check and the fetch. `--max-redirs 0` refuses hops nobody vetted —
the transform already followed them and gave you the final URL. Dropping either
turns the map into a probe of the user's own network.

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

```sh
node scripts/properties.ts list --store '<contents>'
node scripts/properties.ts list --json --store '<contents>'
node scripts/properties.ts get <id> --store '<contents>'
node scripts/properties.ts set <id> rating 4 --store '<contents>'
node scripts/properties.ts set <id> status toured --store '<contents>'
node scripts/properties.ts set <id> notes needs a new roof --store '<contents>'
node scripts/properties.ts rm <id> --store '<contents>'
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

The user's words go in as their own array elements, exactly as they said them.
An apostrophe needs nothing done to it.

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

To reach it from a phone, serve it to the tailnet:

```json
{ "command": ["just", "serve"], "cwd": "/Users/<user>/Plow/skills/property-hunt", "network": true }
```

and `just serve-install` to keep it served across reboots. Both run on the Mac
and print the URL. The file server binds to loopback only; Tailscale is the sole
route in, and it is tailnet-scoped.

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
