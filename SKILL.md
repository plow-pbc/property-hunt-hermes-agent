---
name: property-hunt
description: Track houses for sale on a private map. Use when the user texts a photo or screenshot of a property listing, pastes a listing URL, asks to add or remove a property, wants to rate one, leave notes on one, mark it toured or passed, refresh its price, or asks which houses they have saved. Looks the listing up in the browser on the user's Mac, keeps everything in ~/Plow/properties, and renders a map with photo pins.
---

# Track houses for sale on a private map

The user is house hunting. They text you photos of listings; you identify each
one, look up what the photo doesn't show, and keep a private map they can open
from their Mac.

## Requirements

This skill works through **Plow Latch**, which is how you reach the user's Mac.
It needs three of Latch's tools:

- `plow_browser_open` and `plow_browser` — listing sites refuse plain HTTP
  requests, so the lookup runs through the supervised browser on the Mac.
- `plow_run_command` — runs the scripts that own the store, on the Mac, beside
  the map they write.

Everything is written to `~/Plow/properties/` on the Mac, so the user can open
the map in Finder.

## Paths, before anything else

`plow_run_command` takes an **argv array and runs it directly — there is no
shell**. Two consequences, and both bite silently:

- `~` is never expanded. Use the real absolute path, like
  `/Users/sam/Plow/skills/property-hunt/scripts`.
- Values are separate array elements. Never build one string out of them.

Every call below sets `cwd` to that scripts folder. Run this once at the start
of a session to confirm where the store lives:

```json
{
  "command": ["node", "./properties.ts", "where"],
  "cwd": "/Users/<user>/Plow/skills/property-hunt/scripts"
}
```

## First, always

```json
{
  "command": ["node", "./properties.ts", "init"],
  "cwd": "/Users/<user>/Plow/skills/property-hunt/scripts",
  "writes": ["/Users/<user>/Plow/properties"]
}
```

Idempotent and safe to re-run. It creates the folder, the map page, and an empty
store, and never touches properties already saved.

## Adding a property

A texted photo arrives as a file path. **Read the image** — you need the
address.

**1. Get the listing URL.**

- If the user pasted one, or one is legible in the screenshot, use it.
- Otherwise search for the address on Compass — that is the default source.
  Listing pages look like
  `https://www.compass.com/homedetails/<Address-Slug>/<ID>_pid/`.
- Any listing site works (Zillow, Redfin, an MLS page). Prefer Compass only
  when *you* are the one choosing.

**2. Open a browser session for that site.** Include the apex and the wildcard;
the owner approves this list, so asking for both once avoids a second prompt
mid-hunt.

```json
{
  "tool": "plow_browser_open",
  "origins": ["compass.com", "*.compass.com"],
  "goal": "Read a property listing the user is considering"
}
```

Keep the returned `session` and pass it on every call below.

**3. Load the page.**

```json
{ "tool": "plow_browser", "session": "<session>", "action": "goto", "url": "<listing-url>" }
```

**4. Read the listing.** Use this expression exactly as written. It polls
inside the page, because `goto` returns while a listing is still an empty shell
and reading that shell looks the same as being blocked:

```js
(async () => { const read = () => ({ jsonld: [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => s.textContent), og: Object.fromEntries([...document.querySelectorAll('meta[property^="og:"], meta[name^="twitter:"]')].map(m => [m.getAttribute('property') || m.getAttribute('name'), m.content || ''])) }); const deadline = Date.now() + 10000; let seen = read(); while (Date.now() < deadline) { if (seen.jsonld.length && Object.keys(seen.og).length) return { ...seen, settled: true }; await new Promise(r => setTimeout(r, 750)); seen = read(); } return { ...seen, settled: false }; })()
```

Pass it as the `expression` field:

```json
{
  "tool": "plow_browser",
  "session": "<session>",
  "action": "eval",
  "expression": "<the expression above>"
}
```

It returns `{ jsonld, og, settled }`. Hand the whole thing to the next step
without editing it — `settled` is what tells the saver whether a page that came
back thin is worth reading again.

**5. Save what it returned.** Hand the eval result through unchanged, as one
argv element:

```json
{
  "command": ["node", "./scrape.ts", "--harvest", "<the eval result>", "<listing-url>"],
  "cwd": "/Users/<user>/Plow/skills/property-hunt/scripts",
  "network": true,
  "writes": ["/Users/<user>/Plow/properties"]
}
```

`network` is required: this geocodes the address and downloads the hero photo.
It prints `added <id>` or `refreshed <id>`.

**6. Tell the user what you saved** — one line: address, price, beds/baths/sqft.

### When it fails

A failure prints `{"type":"tool_error","error":"..."}` and saves nothing.

**If the error carries `"retryable": true`**, the page had not finished
rendering. Repeat steps 4 and 5 — up to three attempts total. Do not reload the
page and do not open a second session; the expression polls on its own, so each
attempt gives the page another ten seconds.

**Any other error is final.** Read it and tell the user plainly. When it says
the page does not publish a field, try the same property on another listing
site. Never supply a value you could not measure.

## Editing

Everything the user says about a property maps onto the same few commands. Read
the store, work out which house they mean, then act. Each of these takes the
same `cwd` as above.

```json
{ "command": ["node", "./properties.ts", "list"] }
{ "command": ["node", "./properties.ts", "list", "--json"] }
{ "command": ["node", "./properties.ts", "set", "<id>", "rating", "4"] }
{ "command": ["node", "./properties.ts", "set", "<id>", "status", "toured"] }
{ "command": ["node", "./properties.ts", "set", "<id>", "notes", "needs a new roof, great light"] }
{ "command": ["node", "./properties.ts", "rm", "<id>"] }
```

`status` is free text; `new`, `interested`, `toured`, and `passed` are the ones
the map colours. `rating` is 1–5.

The user's words go in as their own array element, exactly as they said them.
An apostrophe needs nothing done to it — *needs a roof, don't love the kitchen*
is one element and arrives intact.

Match loosely and confirm: *"the one on Elm"* means read `list --json` and find
it. If two could match, ask which.

**To refresh a listing** (price cut, went pending), add it again with the same
four steps. It updates in place and **never touches the user's rating, notes,
or status.**

## Answering questions

Read `list --json` and answer from it. There is no query language and you do not
need one — a house hunt is a few dozen properties. *"Which ones under $2M have I
rated 4 or better?"* is you reading the JSON, not a command.

## The map

`~/Plow/properties/index.html` on the Mac. The user opens it from Finder — no
server. Each pin is the house's photo with its price and bed count, ringed by
status; clicking one opens the listing. Tell them where it is the first time
they add a property.

## Rules

- **Only ever change the store through `scrape.ts` or `properties.ts`** —
  `scrape.ts` adds and refreshes, `properties.ts` edits what you own and
  deletes. **Never edit `data.js` by hand.** Both write atomically, and the map
  may be open at the time.
- **`scraped` is the listing's; `mine` is the user's.** You cannot `set` a
  scraped field — those only come from a scrape, so their timestamp stays
  honest.
- **Never invent a value.** If the scrape did not find the price, it is `null`.
  Say you could not find it.
- A property with no coordinates still gets saved; the map lists it under
  *"not on the map"* rather than dropping it.

## Checking your own work

```json
{
  "command": ["node", "--test", "commands.test.ts", "extract.test.ts", "properties.test.ts", "scrape.test.ts", "store.test.ts"],
  "cwd": "/Users/<user>/Plow/skills/property-hunt/scripts"
}
```
