#!/usr/bin/env bash
# Re-records the provider stream fixtures the parsers are pinned to (plan §15).
# Run after a claude or codex CLI upgrade, then review the diff before committing.
#
# The recorder's own settings, hooks, plugins and MCP servers are suppressed, so a fixture pins
# what the CLI guarantees rather than one machine's chatter. Each recording lands in scratch and
# only replaces the committed fixture once the CLI exited clean.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixtures="$root/packages/core/test/fixtures"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

prompt="Reply with exactly: ok"

cd "$scratch"

echo "claude $(claude --version)"
claude -p \
  --output-format stream-json \
  --verbose \
  --session-id "$(uuidgen | tr 'A-Z' 'a-z')" \
  --permission-mode plan \
  --disallowedTools "Write,Edit,NotebookEdit,Bash" \
  --setting-sources "" \
  --strict-mcp-config \
  -- "$prompt" \
  </dev/null >"$scratch/claude-stream.jsonl"
mv "$scratch/claude-stream.jsonl" "$fixtures/claude-stream.jsonl"

echo "codex $(codex --version)"
codex exec \
  --json \
  --skip-git-repo-check \
  -c sandbox_mode=read-only \
  --ignore-user-config \
  -- "$prompt" \
  </dev/null >"$scratch/codex-stream.jsonl"
mv "$scratch/codex-stream.jsonl" "$fixtures/codex-stream.jsonl"

wc -l "$fixtures"/*.jsonl
