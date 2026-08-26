# property-hunt

Text your agent a photo of a house for sale. It figures out which house, looks
up everything the photo doesn't show, and puts it on a private map you can open
from Finder.

<!-- Runs on a Hermes agent through Plow Latch — https://howto.plow.co/property-hunt -->

## What it does

- **Text a screenshot.** Zillow, Compass, a Redfin listing, a photo of a flyer —
  anything with an address on it. The agent reads the image, finds the real
  listing, and saves it.
- **Talk to it normally.** *"The one on Elm — 3 stars, needs a new roof."*
  *"Mark Oak as passed."* *"Did the Greenwich place drop?"*
- **Open the map.** `~/Plow/properties/index.html`. Every house is a pin showing
  its photo, price, and bed count, coloured by whether you're interested, have
  toured it, or passed. Click one to open the listing.

## What it doesn't need

No server. No API key. No account. No build step. Open the HTML file from Finder
and it works — the map is [Leaflet](https://leafletjs.com), bundled, and your
data is a plain JSON file the page loads directly.

Four things go out to strangers, and nothing else: the listing lookup itself,
one download of that listing's photo from whatever host it lives on, one
[Nominatim](https://nominatim.org) geocoding request per property to turn its
address into a pin, and [OpenStreetMap](https://www.openstreetmap.org/copyright)
map tiles fetched while you have the map open. Your notes and ratings go to
none of those.

They do travel, though, and it is worth knowing where. Anything you ask about a
property sends the whole store — notes and ratings included — across the Plow
relay, because that is how the agent reaches the Mac; an edit sends it back the
same way. Serving the map to your phone sends it to whichever tailnet device
opens it.

## Requirements

A Mac running [Plow Latch](https://github.com/plow-pbc/latch), and a Hermes
agent you can text.

**The Mac holds only Latch and your data.** These scripts run in the agent's
container, from a pinned checkout, and own no state: the store and the harvest
payload arrive in a request file the agent writes, and the new store comes out
on stdout. The agent reads `data.js` off the Mac through Latch, runs the
transform, and writes the result back. Nothing here is installed on the Mac, so
nothing here can fall out of step with the agent.

[howto.plow.co/property-hunt](https://howto.plow.co/property-hunt) is the
install guide.

## Your data

Everything lives in `~/Plow/properties/`:

```
data.js      every property — the file the map reads, and a readable JSON diff
photos/      one hero photo per house
index.html   the map
```

It's yours. Upgrading or removing the skill never touches it. `data.js` is plain
JSON, so you can read it, diff it, or keep it in git.

## Viewing the map on a phone

Ask the agent to serve it. It installs a small launchd job on the Mac that
starts a loopback-bound file server **at login**, then points Tailscale at
that port. Tailscale is the sole route in and it is tailnet-scoped, so the map
reaches your phone and never the public internet.

A LaunchAgent lives in your login session, so it starts when you log in rather
than at boot — after a restart the map comes back once you are logged in.

## Development

No dependencies and no build — Node 24 runs the TypeScript directly:

```sh
just test
```

The transforms take their state as text, so a test can build a store inline; the
CLI tests write it to a request file the way the agent does. A contract test
fails the suite if a script imports `node:fs` at all: one line in
`properties.ts` reads the request file, and no other script imports it — the
tests do, to stage that file.

## License

MIT-0 — see [LICENSE](LICENSE).
