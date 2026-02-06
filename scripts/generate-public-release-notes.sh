#!/usr/bin/env bash
set -euo pipefail

OUTPUT_PATH="${1:-PUBLIC_RELEASE_NOTES.md}"
MAX_COMMITS="${MAX_COMMITS:-8}"

SOURCE_REPO="${GITHUB_REPOSITORY:-unknown}"
SOURCE_SHA="${GITHUB_SHA:-$(git rev-parse HEAD)}"
RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-unknown}/actions/runs/${GITHUB_RUN_ID:-unknown}"
GENERATED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

COMMITS="$(git log -n "$MAX_COMMITS" --pretty=format:'- `%h` %s (%an)' || true)"
if [[ -z "$COMMITS" ]]; then
  COMMITS="- No commit metadata available."
fi

cat > "$OUTPUT_PATH" <<NOTES
# Public Release Notes

Generated automatically from private repository mirror workflow.

## Source
- Repository: \\`${SOURCE_REPO}\\`
- Commit: \\`${SOURCE_SHA}\\`
- Workflow run: ${RUN_URL}
- Generated at (UTC): \\`${GENERATED_AT}\\`

## Recent Changes
${COMMITS}
NOTES
