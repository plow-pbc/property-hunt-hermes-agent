# Node 24 runs the TypeScript directly — no build, no dependencies.

# Run the test suite: the transforms, then the deployment contract.
test:
    node --test skill/scripts/*.test.ts
    uv run --no-project --python 3.13 --with pytest==8.4.2 --with pyyaml==6.0.2 pytest -q tests/
