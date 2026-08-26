"""What makes this agent THIS agent, and nothing that agent-mgr already owns.

The fleet-wide invariants -- the home mount, the uid/gid contract, no credential
through compose, no recipe starting a second gateway -- moved to agent-mgr with
the deployment, and are asserted there once for every agent instead of restated
per repo. What is left here is what this repo says about the deployment it now carries
alongside the skill: that the descriptor claims no identity of its own, that the
shipped config takes its credentials from the environment, and that the mount
hands the agent the skill and nothing else.

Direct assertions about known files, not scans for credential-shaped things.
Three filename or token-name heuristics lived here across this branch and all
three went: each needed exemptions, each had a blind spot, and the last was
defending ground the mount boundary had already taken. Credentials sit outside
`skill/` structurally -- `agent.env` and `.env.example` are at the root by
construction, and `cp .env.example .env` lands there too -- so the guard was the
belt after the braces.
"""

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
    """
    assert descriptor() == {}, (
        f"agent.env declares {sorted(descriptor())}; every one of those is "
        "derivable from the registry name, and declaring it stops a second "
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


def test_the_override_adds_exactly_one_read_only_skill_mount():
    """The skill is mounted from this checkout, not fetched into the home.

    It used to be pinned by SHA and pulled from a second repo, and that is what
    made a half-delivery possible: the installer fetched SKILL.md alone and
    dropped the nested scripts/ and references/ the instructions call, so every
    transform failed with "Cannot find module" while reads kept working. One
    repo, one checkout, no pin to drift.

    Constrained rather than merely present, because agent-mgr asserts its
    TEMPLATE's volume set and nothing asserts an instance's -- its own fixture
    shows an override merging in a vault directory. The override lives here, so
    this is the file that can check it.
    """
    mounts = yaml.safe_load(
        (ROOT / "compose.override.yml").read_text()
    )["services"]["hermes"]["volumes"]
    assert len(mounts) == 1, f"the override widens the mount set by more than the skill: {mounts}"
    # rsplit, not split: the source is ${AGENT_DIR:?...}, whose :? default
    # syntax carries colons of its own.
    source, target, mode = mounts[0].rsplit(":", 2)
    # ${AGENT_DIR}, never a relative path: agent-mgr passes its own
    # templates/compose.yml as the FIRST -f, and Compose resolves relative bind
    # paths against that file's directory -- so "./" here mounts agent-mgr.
    # ${AGENT_DIR}/skill, not ${AGENT_DIR}: the mount is the boundary between
    # this repo and an agent that reads attacker-controlled input, so the
    # checkout root -- .git, agent.env, config.yaml, tests/, and any stray .env
    # an operator drops in -- stays outside it.
    assert source == "${AGENT_DIR:?set by agent-mgr from the registry}/skill", source
    assert target == "/opt/data/skills/productivity/property-hunt", target
    assert mode == "ro", "the agent runs these, it does not edit them"


def test_the_mounted_tree_carries_what_the_instructions_call():
    """SKILL.md's commands are relative to the skill directory, which is skill/."""
    skill_dir = ROOT / "skill"
    text = (skill_dir / "SKILL.md").read_text()
    assert "scripts/properties.ts" in text and "scripts/scrape.ts" in text
    for needed in ("scripts/properties.ts", "scripts/scrape.ts", "references"):
        assert (skill_dir / needed).exists(), f"the mount would carry no {needed}"


def test_the_deployment_half_stays_out_of_the_mount():
    """What the agent can read is skill/, and these are deliberately not in it.

    The mount, not git, is the boundary: an untracked file in the checkout is
    invisible to every guard that reads the index but is handed to the container
    all the same. Keeping the descriptor, the config and the tests at the root
    means the obvious `cp .env.example .env` lands outside the agent's reach.
    """
    for outside in ("agent.env", "config.yaml", ".env.example", "compose.override.yml", "tests"):
        assert (ROOT / outside).exists(), f"{outside} moved -- is it inside the mount now?"
        assert not (ROOT / "skill" / outside).exists(), f"{outside} is inside the mounted tree"


def test_the_readme_names_the_mount_the_override_actually_makes():
    """The runbook and the override have to agree on where the boundary is.

    This moved twice in one branch -- whole checkout, then skill/ -- and the
    README described the old one both times, telling operators a stray root
    .env reached the container when it no longer did. That is worse than
    silence: it is a credential-exposure model that is wrong in the reassuring
    direction.

    Pinned by VALUE, not by prose: the mount source is read out of the override
    and asserted to appear in the README verbatim, the same way SKILL.md is
    pinned to HARVEST_EXPRESSION. A scan for sentences about mounting would be
    out-spelled the first time someone rephrased it.
    """
    mount = yaml.safe_load(
        (ROOT / "compose.override.yml").read_text()
    )["services"]["hermes"]["volumes"][0]
    source, target, _ = mount.rsplit(":", 2)
    # ${AGENT_DIR:?...} carries its own default text; the README names the
    # bare variable and the subdirectory, which is the part an operator acts on.
    subpath = source.split("}", 1)[1]
    readme = (ROOT / "README.md").read_text()
    assert f"${{AGENT_DIR}}{subpath}" in readme, (
        f"the override mounts ${{AGENT_DIR}}{subpath}; the README does not say so"
    )
    assert target.rsplit("/", 1)[-1] in readme
