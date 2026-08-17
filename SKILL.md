---
name: property-hunt
description: Track houses for sale on a private map. Use when the user texts a photo or screenshot of a property listing, pastes a listing URL, asks to add or remove a property, wants to rate one, leave notes on one, mark it toured or passed, refresh its price, or asks which houses they have saved. Looks up the full listing in the browser, keeps everything in ~/Plow/properties, and renders a map with photo pins.
---

# Property hunt

The user is house hunting. They text you photos of listings; you identify each
one, look up what the photo doesn't show, and keep a private map they can open
from their Plow folder.

Everything lives in `/workspace/host/properties/` — that is the user's
`~/Plow/properties` folder on their Mac, so anything you write there they can
open in Finder.

## First, always

```sh
node /workspace/host/skills/property-hunt/scripts/properties.ts init
```

Idempotent and safe to re-run. It creates the folder, the map page, and an empty
store — and never touches properties already saved. Run it before anything else;
if the folder is already set up it just prints where it is.

Every command below uses that same full path. Write it out each time — each
command runs in its own shell, so a shell variable set in one does not survive
into the next.

## Adding a property

A texted photo arrives as a file path. **Read the image** — you need the address.
Then:

1. **Get the listing URL.**
   - If the user pasted one, or one is legible in the screenshot, use it.
   - Otherwise search for the address on Compass — that is the default source.
     Listing pages look like
     `https://www.compass.com/homedetails/<Address-Slug>/<ID>_pid/`.
   - Any listing site works (Zillow, Redfin, an MLS page). Prefer Compass only
     when *you* are the one choosing.
2. **Scrape it, and save it:**

```sh
cd /workspace/host/skills/property-hunt/scripts
node properties.ts upsert --scraped "$(node scrape.ts '<listing-url>')"
```

`scrape.ts` drives the browser, reads the listing, geocodes the address, and
downloads the hero photo. It prints the record; `upsert` files it.

The URL is single-quoted above because it is not a value you wrote. Escape it
per **Quoting** below — that applies to every dynamic value, not just notes.

3. **Tell the user what you saved** — one line: address, price, beds/baths/sqft.

**If the scrape fails** it prints `{"type":"tool_error","error":"..."}` instead of
a record. `upsert` recognises that and refuses, repeating the error — read it,
tell the user plainly, and do not invent values you could not measure.

## Editing

Everything the user says about a property maps onto the same few commands. Read
the store, work out which house they mean, then act.

```sh
cd /workspace/host/skills/property-hunt/scripts
node properties.ts list              # human-readable
node properties.ts list --json       # everything, for you to reason over
node properties.ts set <id> rating 4
node properties.ts set <id> status toured
node properties.ts set <id> notes 'needs a new roof, great light'
node properties.ts rm <id>
```

`status` is free text; `new`, `interested`, `toured`, and `passed` are the ones
the map colours. `rating` is 1–5.

### Quoting — this one bites

Single-quote every value you did not write yourself: notes, statuses, addresses,
listing URLs. **A single-quoted string cannot contain an apostrophe**, so before
you wrap a value, replace every `'` in it with `'\''`:

```sh
# The user said: needs a roof, don't love the kitchen
node properties.ts set <id> notes 'needs a roof, don'\''t love the kitchen'
```

Skipping this does not merely fail — the value ends the quote early and the rest
of it is read as shell syntax. That text can come from a listing page you did not
write, so treat it as hostile input, not as a formatting nicety.

Match loosely and confirm: *"the one on Elm"* means read `list --json` and find
it. If two could match, ask which.

**To refresh a listing** (price cut, went pending), scrape it again with the same
command as adding. It updates in place and **never touches the user's rating,
notes, or status.**

## Answering questions

Read `list --json` and answer from it. There is no query language and you do not
need one — a house hunt is a few dozen properties. *"Which ones under $2M have I
rated 4 or better?"* is you reading the JSON, not a command.

## The map

`~/Plow/properties/index.html`. The user opens it from Finder — no server. Each
pin is the house's photo with its price and bed count, ringed by status; clicking
one opens the listing. Tell them where it is the first time they add a property.

## Rules

- **Only ever change the store through `properties.ts`.** Never edit `data.js`
  by hand. The commands write atomically, and the map may be open at the time.
- **`scraped` is the listing's; `mine` is the user's.** You cannot `set` a
  scraped field — those only come from a scrape, so their timestamp stays honest.
- **Never invent a value.** If the scrape did not find the price, it is `null`.
  Say you could not find it.
- A property with no coordinates still gets saved; the map lists it under
  *"not on the map"* rather than dropping it.

## Checking your own work

```sh
cd /workspace/host/skills/property-hunt/scripts && node --test *.test.ts
```
