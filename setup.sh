#!/usr/bin/env bash
#
# setup.sh — one-shot installer for pi-config
#
# Automates the setup described in README.md: installs pi from npm, copies
# config/extensions/skills into ~/.pi, and wires shell env vars — without
# reproducing herdr / orca managed files (those are installed by their own
# tools, not by this repo).
#
# Usage:
#   ./setup.sh            # interactive (safe defaults, prompts for secrets)
#   ./setup.sh --yes      # non-interactive; use placeholder secrets from templates
#   ./setup.sh --help     # this help
#
# Exit codes:
#   0  success
#   1  missing prerequisite (node/npm/git/curl)
#   2  invalid usage / unknown flag
#
# Idempotent: safe to run multiple times; already-installed pieces are skipped.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NPM_PREFIX="${NPM_PREFIX:-$HOME/.npm-global}"
NPM_PREFIX_EXPANDED="${NPM_PREFIX/#\~/$HOME}"

ASSUME_YES=0

usage() {
  # Print each consecutive comment line at the top (stripping the leading
  # '#'), stopping at the first non-comment line — the end of the doc block.
  awk 'NR > 1 { if ($0 ~ /^# ?/) { sub(/^# ?/, ""); print } else exit }' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes) ASSUME_YES=1; shift ;;
    -h|--help)
      usage
      exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
log()  { printf '\033[1;36m[setup]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[setup]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[setup]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[setup]\033[0m %s\n' "$*"; exit 1; }

confirm() {
  # confirm "<prompt> [y/N] " -> 0 if yes, 1 if no. With --yes always yes.
  [[ $ASSUME_YES -eq 1 ]] && return 0
  local resp
  read -r -p "$1" resp
  [[ "$resp" =~ ^[Yy]$ ]]
}

# ---------------------------------------------------------------------------
# 0. prerequisites
# ---------------------------------------------------------------------------
log "Checking prerequisites..."
for tool in node npm git curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    warn "Missing prerequisite: '$tool'"
    warn "  pi needs a modern Node.js (>= 18). Install it via your package"
    warn "  manager, nvm, or the official Node binaries, then rerun this script."
    fail "Please install '$tool' and re-run ./setup.sh"
  fi
done

node_major="$(node -v | sed 's/^v//; s/\..*//')"
if [[ "$node_major" -lt 18 ]]; then
  fail "pi requires Node >= 18 (found $(node -v)). Upgrade Node, then re-run."
fi
ok "node $(node -v) / npm $(npm -v)"

# ---------------------------------------------------------------------------
# 1. user-local npm prefix + install pi
# ---------------------------------------------------------------------------
if ! command -v pi >/dev/null 2>&1 && [[ ! -x "$NPM_PREFIX_EXPANDED/bin/pi" ]]; then
  log "Setting npm prefix to '$NPM_PREFIX' and installing pi globally..."
  mkdir -p "$NPM_PREFIX_EXPANDED"
  npm config set prefix "$NPM_PREFIX"
  npm install -g @earendil-works/pi-coding-agent
else
  ok "pi already installed ($(command -v pi || echo "$NPM_PREFIX_EXPANDED/bin/pi"))"
fi

# Put the npm-global bin on PATH in ~/.bashrc if not already there.
if ! grep -qs 'npm-global/bin' "$HOME/.bashrc"; then
  log "Adding npm-global bin to PATH in ~/.bashrc..."
  {
    echo ""
    echo "# pi (pi-coding-agent): user-local npm bin on PATH"
    echo "export PATH=$NPM_PREFIX/bin:\$PATH"
  } >> "$HOME/.bashrc"
  warn "Added PATH export to ~/.bashrc — run 'source ~/.bashrc' in new shells."
else
  ok "PATH export already present in ~/.bashrc"
fi

# ---------------------------------------------------------------------------
# 2. copy config / extensions / skills into ~/.pi/agent
# ---------------------------------------------------------------------------
AGENT_DIR="$HOME/.pi/agent"

mkdir -p "$AGENT_DIR/extensions" "$AGENT_DIR/skills"

log "Copying pi config files into $AGENT_DIR ..."
cp "$REPO_DIR/config/settings.json" "$AGENT_DIR/settings.json"
cp "$REPO_DIR/config/trust.json"    "$AGENT_DIR/trust.json"
cp "$REPO_DIR"/extensions/*.ts      "$AGENT_DIR/extensions/"
# note: herdr / orca managed extensions are deliberately NOT shipped here.
cp -r "$REPO_DIR"/skills/*          "$AGENT_DIR/skills/"
ok "Config, extensions, and skills installed."

# ---------------------------------------------------------------------------
# 3. secrets: auth.json + agentmail config
# ---------------------------------------------------------------------------
AUTH_TEMPLATE="$REPO_DIR/config/auth.json.template"

if [[ -f "$AGENT_DIR/auth.json" ]]; then
  ok "auth.json already exists — skipping."
else
  cp "$AUTH_TEMPLATE" "$AGENT_DIR/auth.json"
  if [[ $ASSUME_YES -ne 1 ]]; then
    warn "Created $AGENT_DIR/auth.json from template."
    if confirm "  Open it now to add your real API keys? [y/N] "; then
      "${EDITOR:-vi}" "$AGENT_DIR/auth.json"
    else
      warn "  Leave it — edit $AGENT_DIR/auth.json before running pi."
    fi
  else
    warn "Created $AGENT_DIR/auth.json with placeholder keys — edit it manually."
  fi
fi

# agentmail skill secrets
if command -v python3 >/dev/null 2>&1; then
  ok "python3 found (required by the agentmail skill)."
else
  warn "python3 not found — the agentmail skill will not work until it is installed."
fi

AGENTMAIL_CONFIG="$AGENT_DIR/skills/agentmail/config.json"
if [[ -f "$AGENTMAIL_CONFIG" ]]; then
  if grep -q 'YOUR_AGENTMAIL_API_KEY' "$AGENTMAIL_CONFIG"; then
    warn "agentmail config still has placeholder keys — edit $AGENTMAIL_CONFIG"
    warn "  or set AGENTMAIL_API_KEY / AGENTMAIL_INBOX env vars."
  else
    ok "agentmail config already has real keys."
  fi
fi

# ---------------------------------------------------------------------------
# 4. environment variables in ~/.bashrc
# ---------------------------------------------------------------------------
if grep -qs 'pi: optional provider env' "$HOME/.bashrc"; then
  ok "Provider env vars already present in ~/.bashrc — skipping."
else
  log "Wiring shell env vars into ~/.bashrc..."
  {
    echo ""
    echo "# pi: optional provider env (replace with your own values)"
    echo 'export NOVITA_API_KEY="YOUR_NOVITA_API_KEY"'
    echo '# Optional overrides for the fetch-models-x220 extension'
    echo '# export MODELS_SERVER_URL="http://x220:8317"'
    echo '# export MODELS_API_KEY="local"'
  } >> "$HOME/.bashrc"
  warn "Added NOVITA_API_KEY placeholder to ~/.bashrc — fill in your real key."
fi

# ---------------------------------------------------------------------------
# 5. done
# ---------------------------------------------------------------------------
ok "Setup complete."
echo ""
echo "Next steps:"
echo "  1. source ~/.bashrc"
echo "  2. fill in secrets in ~/.pi/agent/auth.json"
echo "  3. edit ~/.pi/agent/skills/agentmail/config.json (or set env vars)"
echo "  4. run: pi"
echo ""
echo "Tip: if the x220 model server isn't reachable, set "
echo "     MODELS_SERVER_URL / MODELS_API_KEY in ~/.bashrc."