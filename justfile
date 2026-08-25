# Node 24 runs the TypeScript directly — no build, no dependencies.

PORT := "8787"
TAILSCALE := "/Applications/Tailscale.app/Contents/MacOS/Tailscale"

# Run the test suite.
test:
    node --test scripts/*.test.ts

# Serve the map to the tailnet. Idempotent — safe to re-run.
serve:
    #!/usr/bin/env bash
    set -euo pipefail
    dir="$HOME/Plow/properties"
    [ -d "$dir" ] || { echo "no $dir yet — the agent creates it on the first save" >&2; exit 1; }

    # Loopback only. Tailscale is the sole route in and it is tailnet-scoped;
    # a 0.0.0.0 bind would put the map, and the addresses in it, on the LAN.
    if ! pgrep -f "http.server {{PORT}}" >/dev/null; then
      nohup python3 -m http.server {{PORT}} --bind 127.0.0.1 --directory "$dir" \
        >/tmp/property-map.log 2>&1 &
      sleep 1
    fi
    curl -fsS -o /dev/null "http://127.0.0.1:{{PORT}}/" \
      || { echo "the file server did not come up — see /tmp/property-map.log" >&2; exit 1; }

    # Path serving is refused by the sandboxed App Store build ("Path serving
    # is not supported on macOS"). Proxying a localhost port is what it does
    # support, and is why the file server above exists at all.
    {{TAILSCALE}} serve --bg {{PORT}}
    {{TAILSCALE}} serve status

# Keep the map served across logout and reboot.
serve-install:
    #!/usr/bin/env bash
    set -euo pipefail
    plist="$HOME/Library/LaunchAgents/co.plow.property-map.plist"
    mkdir -p "$(dirname "$plist")"
    sed -e "s|@PORT@|{{PORT}}|g" -e "s|@DIR@|$HOME/Plow/properties|g" \
      references/launchd/co.plow.property-map.plist > "$plist"
    # Unload first so a re-run replaces the definition rather than erroring.
    launchctl unload "$plist" 2>/dev/null || true
    launchctl load "$plist"
    echo "loaded $plist — the file server now starts at login"
    just serve
