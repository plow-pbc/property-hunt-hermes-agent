# property-hunt

Text Plow a photo of a house for sale. It figures out which house, looks up
everything the photo doesn't show, and puts it on a private map you can open
from your Plow folder.

<!-- Requires Plow — https://plow.co -->

## What it does

- **Text a screenshot.** Zillow, Compass, a Redfin listing, a photo of a flyer —
  anything with an address on it. Plow reads the image, finds the real listing,
  and saves it.
- **Talk to it normally.** *"The one on Elm — 3 stars, needs a new roof."*
  *"Mark Oak as passed."* *"Did the Greenwich place drop?"*
- **Open the map.** `~/Plow/properties/index.html`. Every house is a pin showing
  its photo, price, and bed count, coloured by whether you're interested, have
  toured it, or passed. Click one to open the listing.

## What it doesn't need

No server. No API key. No account. No build step. Open the HTML file from Finder
and it works — the map is [Leaflet](https://leafletjs.com) with
[OpenStreetMap](https://www.openstreetmap.org/copyright) tiles, both bundled, and
your data is a plain JSON file the page loads directly.

Nothing leaves your Mac except the listing lookups themselves.

## Requirements

Plow with **Plow Browser enabled** (Settings → Plow Browser). Listing sites block
plain HTTP requests, so the lookup runs through Plow's real browser.

## Your data

Everything lives in `~/Plow/properties/`:

```
data.js      every property — the file the map reads, and a readable JSON diff
photos/      one hero photo per house
index.html   the map
```

It's yours. Upgrading or removing the skill never touches it. `data.js` is plain
JSON, so you can read it, diff it, or keep it in git.

Addresses are geocoded through OpenStreetMap's
[Nominatim](https://nominatim.org) service, which is the only third party
involved beyond the listing site itself.

## Development

No dependencies and no build — Node 24 runs the TypeScript directly.

```sh
node --test scripts/*.test.ts     # the suite
node scripts/install-local.ts     # install this working copy into ~/Plow/skills
```

## License

MIT
