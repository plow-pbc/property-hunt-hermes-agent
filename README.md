# property-hunt

Text your agent a photo of a house for sale. It figures out which house, looks
up everything the photo doesn't show, and puts it on a private map served on
your own Mac at `http://127.0.0.1:8787/`.

<!-- Runs on a Hermes agent through Plow Latch — https://howto.plow.co/property-hunt -->

## What it does

- **Text a screenshot.** Zillow, Compass, a Redfin listing, a photo of a flyer —
  anything with an address on it. The agent reads the image, finds the real
  listing, and saves it.
- **Talk to it normally.** *"The one on Elm — 3 stars, needs a new roof."*
  *"Mark Oak as passed."* *"Did the Greenwich place drop?"*
- **Open the map.** `http://127.0.0.1:8787/`. Every house is a pin showing
  its photo, price, and bed count, coloured by whether you're interested, have
  toured it, or passed. Click one to open the listing.

## What it doesn't need

No API key. No account. No build step. No cloud: the map is
[Leaflet](https://leafletjs.com), bundled, and your data is a plain file on your
own disk.

It does need a file server, and only because opening the page from Finder does
not work. The map loads its store and Leaflet as separate files, and WebKit —
Safari and everything built on it — refuses to load a subresource from a
`file://` page, so the map comes up empty. The agent sets up a loopback-bound
Python file server on the first save; nothing listens beyond your own machine.

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

A Mac running [Plow Latch](https://github.com/plow-pbc/latch), a working
`python3` on it for the map's file server, and a Hermes agent you can text.
Tailscale as well, but only if you want the map on your phone.

**The Mac holds only Latch and your data.** These scripts run in the agent's
container, out of the seeded home copy of `skill/`, and own no state: the store and
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
`gh` authenticated (`gh auth status` — `deploy` fetches the Plow Chat plugin
through it), and a Mac running Plow Latch.

```sh
git clone https://github.com/plow-pbc/property-hunt-hermes-agent.git ~/services/property-hunt-hermes-agent
agent-mgr register property ~/services/property-hunt-hermes-agent   # supplies ${AGENT_DIR}
agent-mgr deploy  property   # config, the Plow Chat plugin, and an empty dotenv

# Now fill ~/.hermes-property/.env with DOMO_DEVICE_UID and DOMO_MCP_TOKEN,
# minted from the Mac running Latch — see .env.example for how. `deploy` only
# lays down the empty skeleton and never overwrites it, and config.yaml reads
# both as ${VAR} at runtime, so an unfilled pair authenticates as nothing
# rather than failing loudly.

agent-mgr activate   property   # prints a code to text; consumes a line from the Plow pool
agent-mgr up         property   # must precede sign-in: that runs inside this container
agent-mgr check-latch property  # asks the relay, from inside the container, whether the pair works
agent-mgr sign-in    property   # one-time browser OAuth for this agent
agent-mgr agent      property 'which houses have I saved?'   # a turn without the phone
```

Register the checkout itself: that row supplies the checkout path, and
`deploy` runs this repo's `deploy-hook`, which seeds `skill/` into the agent's
home at `skills/productivity/property-hunt` — copied when absent or empty,
never over a non-empty agent-owned copy. The home copy is
the one the agent runs, and it is writable: the agent edits and improves its
own skill there, the same way it manages skills it authors itself, so drifting
from this checkout is normal. A later deploy never overwrites it; re-seeding
is deliberate (remove the home copy, deploy again).

**Only `skill/` is seeded.** Everything else here — `agent.env`, `config.yaml`,
`.env.example`, `tests/`, `.git` — stays outside the agent's reach. That is
deliberate: this agent reads attacker-controlled input by design (a listing
page's own JSON-LD, a pasted URL, a texted screenshot) while holding a Latch
credential to your Mac, so what is reachable from its skill directory is worth
being narrow about.

**Your credentials never live in either place.** They live in
`~/.hermes-property/.env`. The obvious slip — `cp .env.example .env` — lands at
the root of this checkout, which is never seeded, so it stays out of the
container. Nothing enforces that for a file put inside `skill/` directly; don't.

### Deploying a change

```sh
cd ~/services/property-hunt-hermes-agent && git pull
AGENT_TRANSITION_ACK=1 agent-mgr deploy property && AGENT_TRANSITION_ACK=1 agent-mgr up property
```

Every transition here asks first: `agent.env` declares `AGENT_LIVE=1`
because real people's workflows run through this agent and the gateway
messages them at every restart, so agent-mgr prompts `[y/N]` at a
terminal and refuses non-interactively. `AGENT_TRANSITION_ACK=1` is the non-interactive
acknowledgement — set it only when the restart is the point, as above.

One recipe for every file here, deliberately: `config.yaml` is read at gateway
start and `agent.env` when Compose renders, so a `git pull` alone leaves a
running agent on the old values with no error.

**A pull does not update a seeded skill.** The agent's home copy is its own —
that is the point — so a skill change in this repo reaches an existing agent
only when someone re-seeds deliberately (remove the home copy, deploy again)
or hands the change to the agent to apply itself.

`agent.env` declares no identity on purpose — its declarations are
`AGENT_LIVE=1` above and `AGENT_DEPLOY_HOOK=deploy-hook`; see the comments in it.

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

## Where changes go

This repo is one of several that assemble a Plow agent. The map of which repo
owns what is in
[`plow-hermes-agent` README § The repos](https://github.com/plow-pbc/plow-hermes-agent#the-repos);
read it before a change that touches a neighbour. The test is **who else would
have to change if this fact changed** — if the answer is a sibling, the change
belongs there and this repo takes a pin bump.

Not here:

- **Seeding and deploying** — `agent-mgr` owns the mechanism (`lib/fetch-tree`
  plus `replay_skills()` off a `skills.tsv` manifest). This repo names a hook;
  it should not carry a second copier.
- **Container lifecycle** — the transition prompt, the compose template, the one
  mount: `agent-mgr` again. This repo only *declares* the fact
  (`agent.env` `AGENT_LIVE=1`).
- **The config keys every agent shares** — plugin enablement,
  `platforms.plow_chat`, the relay `mcp_servers` block, memory and display
  defaults: the base image, `plow-hermes-agent` `image/seed/config.yaml`. Only
  the model and its fallbacks are this repo's reason to exist.
- **How a turn is framed, the Plow tools, trust and group policy** —
  `hermes-plow-chat` and `plow`. The Mac-side tools this skill drives are
  `latch`'s.

Examples:

- Adherence — #16 deleted this repo's own `scripts/confirm-external-user`
  transition guard once the mechanism landed in `agent-mgr#56`, leaving one
  declared line behind: https://github.com/plow-pbc/property-hunt-hermes-agent/pull/16
- Violation — #21 added a 32-line `deploy-hook` that re-implements agent-mgr's
  `fetch-tree` + `skills.tsv` seeding, its own comment naming the shape it
  copies: https://github.com/plow-pbc/property-hunt-hermes-agent/pull/21

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

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Copyright 2026 The Plow Collective, Inc.

"Plow" and the Plow logo are trademarks of The Plow Collective, Inc. The license grants no trademark rights.
