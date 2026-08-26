"""What makes this agent THIS agent, and nothing that agent-mgr already owns.

The fleet-wide invariants -- the home mount, the uid/gid contract, no credential
through compose, no recipe starting a second gateway -- moved to agent-mgr with
the deployment, and are asserted there once for every agent instead of restated
per repo. What is left here is what this repo says about the deployment it now carries
alongside the skill: that the descriptor claims no identity of its own, and that
the shipped config takes its credentials from the environment.
"""

from pathlib import Path

import pytest
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
        # `sk-...` line silently -- and agent.env is exempted from the
        # credential guard on the strength of a test that reads through this,
        # so a line this reader cannot see is a line nothing checks.
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


def test_no_credential_file_is_tracked():
    """Credentials live in this agent's home dotenv, which is outside the repo.

    Two named exemptions, and everything else keeps the broad shape rule. An
    earlier pass swapped the suffix rule for exact basenames to stop `agent.env`
    tripping it -- and quietly stopped catching `prod.env`, `secrets.env`,
    `auth.json.bak` and `latch-auth.json` along the way. A false positive on one
    known filename is an allowlist problem, not a reason to narrow the rule.

    -z, because this is a security guard and a filename must not be able to
    defeat it: git C-quotes paths with non-ASCII bytes, so `café/.env` arrives
    as `"caf\303\251/.env"` and its basename computes to `.env"`, and
    whitespace-splitting fragments any path containing a space.
    """
    import subprocess
    out = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT,
                         capture_output=True, text=True, check=True)
    for name in out.stdout.split("\0")[:-1]:
        base = name.rsplit("/", 1)[-1]
        # Anchored to the full path git prints, not the basename. The two
        # exemptions are excused because two other tests cover those exact
        # files -- and those tests read ROOT/agent.env and ROOT/.env.example, so
        # a `secrets/agent.env` or `runtime/.env.example` matched by basename
        # would be excused by a promise nothing checks. Same reasoning as -z
        # above, one level up: the allowlist must not be the weakest link.
        if name in ("agent.env", ".env.example"):
            continue
        assert not base.endswith(".env"), f"{name} is tracked"
        assert not base.startswith(".env."), f"{name} is tracked"
        assert "auth.json" not in base and "auth.lock" not in base, f"{name} is tracked"


def test_the_dotenv_example_carries_no_values():
    """The exemption above rests on this: it is a shape, not a secret store."""
    keys = dotenv(ROOT / ".env.example")
    assert keys, ".env.example declares no keys -- is it still the skeleton?"
    for line in keys:
        key, value = line.split("=", 1)
        assert value == "", f".env.example carries a value for {key}"

def test_the_shipped_config_names_its_secrets_by_variable():
    text = (ROOT / "config.yaml").read_text()
    for line in text.splitlines():
        if "Authorization" in line or "token" in line.lower():
            assert "${" in line, f"a literal credential in config.yaml: {line.strip()}"
