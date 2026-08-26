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
container, out of this repo's own checkout, and own no state: the store and
the harvest payload arrive in a request file the agent writes, and the new
store comes out on stdout. The agent reads `data.js` off the Mac through Latch, runs the
transform, and writes the result back. Nothing here is installed on the Mac, so
nothing here can fall out of step with the agent.

[howto.plow.co/property-hunt](https://howto.plow.co/property-hunt) is the
install guide.

## Running it

This repo is the whole agent: the skill *and* the deployment that carries it.
`agent-mgr` supplies everything true of every Hermes agent; nothing here names
which person it serves, so a second operator registers their own row against
their own checkout and gets their own home, container and project.

You need [`agent-mgr`](https://github.com/plow-pbc/agent-mgr), a Docker daemon,
`gh` authenticated (`gh auth status` — `restore` fetches the Plow Chat plugin
through it), and a Mac running Plow Latch.

```sh
git clone https://github.com/plow-pbc/property-hunt-hermes-agent.git ~/services/property-hunt-hermes-agent
agent-mgr register property ~/services/property-hunt-hermes-agent   # supplies ${AGENT_DIR}
agent-mgr restore  property   # config, the Plow Chat plugin, and an empty dotenv

# Now fill ~/.hermes-property/.env with DOMO_DEVICE_UID and DOMO_MCP_TOKEN,
# minted from the Mac running Latch — see .env.example for how. `restore` only
# lays down the empty skeleton and never overwrites it, and config.yaml reads
# both as ${VAR} at runtime, so an unfilled pair authenticates as nothing
# rather than failing loudly.

agent-mgr activate   property   # prints a code to text; consumes a line from the Plow pool
agent-mgr up         property   # must precede sign-in: that runs inside this container
agent-mgr check-latch property  # asks the relay, from inside the container, whether the pair works
agent-mgr sign-in    property   # one-time browser OAuth for this agent
agent-mgr agent      property 'which houses have I saved?'   # a turn without the phone
```

Register the checkout itself: that row supplies `${AGENT_DIR}`, and the override
mounts `${AGENT_DIR}/skill` from it. A wrong path is how the container ends up
with no `skill/scripts/`.

**Only `skill/` enters the container.** Everything else here — `agent.env`,
`config.yaml`, `.env.example`, `tests/`, `.git` — stays outside it. That is
deliberate: this agent reads attacker-controlled input by design (a listing
page's own JSON-LD, a pasted URL, a texted screenshot) while holding a Latch
credential to your Mac, so what is reachable from its skill directory is worth
being narrow about.

**Your credentials never live in either place.** They live in
`~/.hermes-property/.env`. The obvious slip — `cp .env.example .env` — lands at
the root of this checkout, which is outside the mount, so it stays out of the
container. Nothing enforces that for a file put inside `skill/` directly; don't.

### Deploying a change

```sh
cd ~/services/property-hunt-hermes-agent && git pull
agent-mgr restore property && agent-mgr up property
```

One recipe for every file here, deliberately. Only `skill/scripts/` and
`skill/references/` are genuinely live — the agent execs those out of the mount
each turn. Everything else is read once and held: `skill/SKILL.md` and
`config.yaml` at gateway start, `agent.env` and `compose.override.yml` when
Compose renders. A
`git pull` alone leaves a running agent on the old values with no error, and
which files that applies to is not worth remembering when the full recipe costs
a few seconds.

**What the agent is running is the working tree, not `HEAD`.** A bind mount
serves what is on disk, so a dirty or mid-pull deploy clone serves that, while
`git rev-parse HEAD` reports something else. Keep `~/services/property-hunt-hermes-agent`
clean and on `main`; to check what is actually live:

```sh
git -C ~/services/property-hunt-hermes-agent status --porcelain   # must be empty
git -C ~/services/property-hunt-hermes-agent rev-parse HEAD
```

`agent.env` declares nothing on purpose — see the comments in it.

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
