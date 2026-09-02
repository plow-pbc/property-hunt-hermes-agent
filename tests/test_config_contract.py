"""What makes this agent THIS agent, and nothing that agent-mgr already owns.

The fleet-wide invariants -- the home mount, the uid/gid contract, no credential
through compose, no recipe starting a second gateway -- moved to agent-mgr with
the deployment, and are asserted there once for every agent instead of restated
per repo. What is left here is what this repo says about the deployment it now carries
alongside the skill: that the descriptor claims no identity of its own, that the
shipped config takes its credentials from the environment, and that the deploy
hook seeds the agent the skill and nothing else.

Direct assertions about known files, not scans for credential-shaped things.
Three filename or token-name heuristics lived here across this branch and all
three went: each needed exemptions, each had a blind spot, and the last was
defending ground the skill boundary had already taken. Credentials sit outside
`skill/` structurally -- `agent.env` and `.env.example` are at the root by
construction, and `cp .env.example .env` lands there too -- so the guard was the
belt after the braces.
"""

import subprocess
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent


def dotenv(path):
    """The KEY=VALUE lines of a dotenv, stripped, comments dropped.

    One reader for every assertion this file makes about a dotenv. There were
    three hand-rolled ones and they disagreed: this filters on the STRIPPED
    line, where an earlier descriptor() tested `#` on the raw line -- so an
    indented comment reached its dict(split) and raised ValueError, taking down
    every test that called it, while the newer copies quietly skipped it. Two
    views of the same file is the one thing a file whose job is asserting that
    file's contract cannot have.
    """
    lines = [l for l in (x.strip() for x in path.read_text().splitlines())
             if l and not l.startswith("#")]
    for l in lines:
        # Loud, not skipped. An `"=" in l` filter here would drop a bare
        # `sk-...` line silently, and every assertion this file makes about a
        # dotenv reads through here -- so a line this reader cannot see is a
        # line nothing in this suite checks.
        assert "=" in l, f"{path.name}: not a KEY=VALUE line: {l!r}"
    return lines


def descriptor():
    return dict(line.split("=", 1) for line in dotenv(ROOT / "agent.env"))

def test_the_descriptor_claims_no_identity():
    """Declaring any AGENT_* value here pins this repo to one person.

    agent-mgr derives AGENT_HOME, AGENT_CONTAINER and AGENT_PROJECT from the
    REGISTRY NAME, so two rows against two checkouts of this repo resolve to
    separate homes and containers. A declared AGENT_HOME defeats that outright
    -- require_own_home refuses the second instance, because it resolves to the
    first one's home.

    This repo used to declare AGENT_PROJECT, to hold a docker project name
    inherited from a checkout directory. That directory is gone and the project
    converged on the convention during the move, so the descriptor is now bare
    and nothing here is about a particular person.

    Per-person values that are not identity -- a different Mac, a different
    model -- go in ~/.hermes-<name>/.env and reach config.yaml as ${VAR}.

    AGENT_LIVE and AGENT_DEPLOY_HOOK are the declarations allowed through:
    both are properties of every instance of this repo, not of a person.
    AGENT_LIVE because real people's workflows run through each one, so
    agent-mgr asks before any transition; AGENT_DEPLOY_HOOK because it is a
    repo-relative path that agent-mgr resolves against each instance's own
    checkout.
    """
    assert descriptor() == {"AGENT_LIVE": "1", "AGENT_DEPLOY_HOOK": "deploy-hook"}, (
        f"agent.env declares {sorted(descriptor())}; identity keys are "
        "derivable from the registry name, and declaring one stops a second "
        "person from registering their own row against this repo"
    )


def test_the_config_sits_where_agent_mgr_looks_without_being_told():
    """AGENT_CONFIG defaults to config.yaml beside the descriptor.

    Keeping it there is what lets the descriptor stay bare -- the previous
    layout put it under runtime/ and had to declare the path to say so.
    """
    assert (ROOT / "config.yaml").is_file()


def test_the_phone_line_is_enabled():
    cfg = yaml.safe_load((ROOT / "config.yaml").read_text())
    assert "plow-chat-platform" in cfg["plugins"]["enabled"]
    assert cfg["platforms"]["plow_chat"]["enabled"] is True


def test_compression_has_somewhere_to_fall_back_to():
    """An empty chain is the incident: on a full-budget timeout the aux client
    skips the same-provider retry and falls back, so with nothing configured an
    oversized session freezes and every turn re-stalls. Asserts only that a
    landing spot exists -- the model and timeouts are deployment choices."""
    cfg = yaml.safe_load((ROOT / "config.yaml").read_text())
    assert cfg["auxiliary"]["compression"]["fallback_chain"]


def test_latch_is_configured_from_the_environment_not_from_git():
    """The credential decides which Mac this agent can drive; it is never in git.

    The set check backs README's "Hostex and Seam. No PMS access, no lock
    control." Nothing else asserted it, and config.yaml's own comment points at
    "the same shape the rentals agent uses for Hostex" -- so the copy-paste the
    README names has a worked example sitting three lines above where it would
    land, and shape-only assertions would pass it green.
    """
    cfg = yaml.safe_load((ROOT / "config.yaml").read_text())
    assert set(cfg["mcp_servers"]) == {"latch"}
    latch = cfg["mcp_servers"]["latch"]
    assert "${DOMO_DEVICE_UID}" in latch["url"]
    assert "${DOMO_MCP_TOKEN}" in latch["headers"]["Authorization"]


def test_the_dotenv_example_carries_no_values():
    """The likeliest leak in this repo, and the one .gitignore structurally cannot stop.

    `.env.example` is tracked on purpose -- it is the contract for what the
    agent's home dotenv must hold -- so filling it in and committing is a
    credential in git with nothing in the way. Asserted as a shape: keys, and
    no values.
    """
    keys = dotenv(ROOT / ".env.example")
    assert keys, ".env.example declares no keys -- is it still the skeleton?"
    for line in keys:
        key, value = line.split("=", 1)
        assert value == "", f".env.example carries a value for {key}"


def test_the_skill_is_seeded_writable_not_mounted_read_only():
    """The deploy hook copies skill/ into the agent's home; there is no mount.

    The skill was bind-mounted :ro from this checkout, and that made it
    uneditable: every skill_manage write died with EROFS. The agent is meant to
    improve its own skill, so the home copy -- the same writable store where it
    keeps skills it authors itself -- is the one it runs; this checkout is only
    the seed. No compose.override.yml may reappear with a skill mount: a mount
    at the same target would shadow the seeded copy read-only again.

    The runbook has to name the seed's destination. Pinned by VALUE, the way
    SKILL.md is pinned to HARVEST_EXPRESSION: a scan for sentences about
    seeding gets out-spelled the first time someone rephrases; a literal that
    must appear cannot.
    """
    assert not (ROOT / "compose.override.yml").exists(), (
        "an override is back -- a skill mount would shadow the seeded copy read-only"
    )
    hook = ROOT / "deploy-hook"
    assert hook.is_file(), "agent.env declares deploy-hook; the script is missing"
    assert hook.stat().st_mode & 0o111, "agent-mgr refuses a non-executable deploy hook"
    assert "skills/productivity/property-hunt" in (ROOT / "README.md").read_text(), (
        "the hook seeds skills/productivity/property-hunt; the README does not say so"
    )


def test_the_hook_seeds_once_and_never_clobbers_the_agents_copy():
    """First run copies what the instructions call and nothing else; a second
    run leaves the agent's edits.

    All three halves are asserted against the SEEDED OUTPUT, not the source
    layout, so there is one description to keep true. The full tree, because
    the skill was once pinned and fetched from a second repo and the installer
    delivered SKILL.md alone, dropping the scripts/ and references/ the
    instructions call. The deployment half absent, because the descriptor, the
    config and the tests must stay outside the agent's reach -- the obvious
    `cp .env.example .env` lands at the root, which is never seeded.
    Never-clobber, because the home copy is the agent's -- its edits are the
    point of seeding instead of mounting.
    """
    with tempfile.TemporaryDirectory() as home:
        env = {"AGENT_HOME": home, "PATH": "/usr/bin:/bin"}
        # The retired :ro mount left a bare mountpoint dir in migrated homes;
        # seeding must treat that empty dir as absent (it ate mark-property's
        # first real deploy), so the first run starts from exactly that state.
        (Path(home) / "skills" / "productivity" / "property-hunt").mkdir(parents=True)
        first = subprocess.run(["./deploy-hook"], cwd=ROOT, env=env, capture_output=True, text=True)
        assert first.returncode == 0, first.stderr
        seeded = Path(home) / "skills" / "productivity" / "property-hunt"
        text = (seeded / "SKILL.md").read_text()
        assert "scripts/properties.ts" in text and "scripts/scrape.ts" in text
        for needed in ("scripts/properties.ts", "scripts/scrape.ts", "references"):
            assert (seeded / needed).exists(), f"the seed carried no {needed}"
        for outside in ("agent.env", "config.yaml", ".env.example", "deploy-hook", "tests"):
            assert not (seeded / outside).exists(), f"{outside} is inside the seeded tree"
        (seeded / "SKILL.md").write_text("the agent's edit")
        second = subprocess.run(["./deploy-hook"], cwd=ROOT, env=env, capture_output=True, text=True)
        assert second.returncode == 0, second.stderr
        assert (seeded / "SKILL.md").read_text() == "the agent's edit", (
            "a redeploy overwrote the agent's copy"
        )
