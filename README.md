# pi-config

How to set up [pi (pi-coding-agent)](https://github.com/earendil-works/pi-coding-agent)
**from scratch** to reproduce the current installation on this machine
(`tony@x220`, home dir `/home/tony`).

This repo contains:

```
README.md            # this guide
setup.sh             # one-shot installer (automates everything below)
config/              # pi agent config files (secrets replaced with placeholders)
  settings.json      # live copy of ~/.pi/agent/settings.json
  models.json        # snapshot of the x220 catalog (extension fetches it live)
  trust.json         # live copy of ~/.pi/agent/trust.json
  auth.json.template # secrets template; copy to ~/.pi/agent/auth.json
extensions/          # pi extensions (drop into ~/.pi/agent/extensions/)
  fetch-models-x220.ts
  pi-ask.ts
  autofile.ts
skills/              # pi skills (drop into ~/.pi/agent/skills/)
  agentmail/
npm/                 # reference: resolved package versions (~/.pi/agent/npm/package.json)
shell/               # shell snippets to source from ~/.bashrc / ~/.bash_aliases
  bashrc.snippet
```

> The `x220` host name refers to this machine. If you are reproducing this on
> another box, replace `x220` with your hostname / model-server address
> everywhere (and in `fetch-models-x220.ts`).

> herdr / orca managed extensions are **not** shipped here — those are installed
> by their own tools (`herdr`, `Orca`), not cloned from this repo.

---

## 0. One-shot installer — `setup.sh`

Run `./setup.sh` to automate everything below. It is idempotent (safe to run)
and performs these steps:

1. Checks prerequisites (`node` >= 18, `npm`, `git`, `curl`).
2. Sets the user-local npm prefix and installs pi globally.
3. Adds the npm-global bin to `PATH` in `~/.bashrc` (only once).
4. Copies `config/`, `extensions/`, and `skills/` into `~/.pi/agent`.
5. Deploys `auth.json` from the template.
6. Appends provider env-var placeholders to `~/.bashrc` (only once).

```bash
./setup.sh            # interactive (safe defaults, prompts for secrets)
./setup.sh --yes      # non-interactive; use placeholder secrets
./setup.sh --help     # options / exit codes
```

Still fill in your real secrets (Section 3) and `source ~/.bashrc` afterwards.
The step-by-step guide below automates the same work.

---

## 1. Prerequisites

- A Linux machine (this setup was done on Arch-flavored `x220`).
- `git`, `curl`, and a working network connection.
- A model provider. This setup uses a local OpenAI-compatible proxy exposed at
  `http://x220:8317/v1` (the `x220` provider) plus a DeepSeek key via
  `auth.json`.

### Install Node.js + npm

pi requires a modern Node. This machine runs:

```bash
node -v   # v26.4.0
npm  -v   # 11.18.0
```

Install via your package manager, `nvm`, or the official Node binaries. Make
sure `npm` is available.

---

## 2. Install pi globally (npm)

Install pi into a user-local npm prefix so it does not need root:

```bash
# Create a user npm prefix (already present on this machine at ~/.npm-global)
mkdir -p ~/.npm-global

# Make npm install global packages into that prefix
npm config set prefix '~/.npm-global'

# Install pi
npm install -g @earendil-works/pi-coding-agent
```

This puts the `pi` binary at `~/.npm-global/bin/pi`.

### Put the npm-global bin on PATH

Add this to your `~/.bashrc` (see `shell/bashrc.snippet`):

```bash
export PATH=~/.npm-global/bin:$PATH
```

Then `source ~/.bashrc` and verify:

```bash
which pi
pi --version   # 0.83.0
```

---

## 3. Authenticate / configure providers

pi stores agent state under `~/.pi/agent`. Create the directory and copy the
config files from this repo:

```bash
mkdir -p ~/.pi/agent/extensions ~/.pi/agent/skills
cp config/settings.json   ~/.pi/agent/settings.json
cp config/trust.json      ~/.pi/agent/trust.json
cp -r extensions/*.ts     ~/.pi/agent/extensions/
cp -r skills/*            ~/.pi/agent/skills/
```

`models.json` is intentionally **not** copied: the `x220` provider and its
models are registered at runtime by `extensions/fetch-models-x220.ts`
(which queries `http://x220:8317/v1/models`), and DeepSeek models are
auto-discovered from the `auth.json` key. `config/models.json` is kept here
only as a readable snapshot of the current catalog — see
`fetch-models-x220.ts` for the authoritative list.

### Secrets — `auth.json`

`config/auth.json.template` shows the shape of `~/.pi/agent/auth.json`. Copy it
and fill in your real keys (do **not** commit the filled-in file):

```bash
cp config/auth.json.template ~/.pi/agent/auth.json
$EDITOR ~/.pi/agent/auth.json
```

This machine currently has a `deepseek` key set there. Keys placed in
`auth.json` are picked up by pi and used for the matching provider. The
`deepseek` provider's model catalog is cached by pi in
`~/.pi/agent/models-store.json` (regenerated automatically).

The `fetch-models-x220` extension also reads an optional key file at
`~/.pi/agent/x220-api-key` (or `MODELS_API_KEY`), falling back to a dummy
`local` value.

### Secrets — agentmail skill

`skills/agentmail/config.json` is committed with placeholder values. Fill in
your real AgentMail API key + inbox:

```bash
$EDITOR ~/.pi/agent/skills/agentmail/config.json   # or export AGENTMAIL_API_KEY / AGENTMAIL_INBOX
```

Do not commit the real key.

---

## 4. Environment variables

Shell environment variables used by pi / extensions (see
`shell/bashrc.snippet`):

| Variable            | Purpose                                              |
|---------------------|------------------------------------------------------|
| `PATH`              | must include `~/.npm-global/bin`                     |
| `NOVITA_API_KEY`    | API key for Novita (used by some `x220` models)      |
| `MODELS_SERVER_URL` | override for the model server URL (default `http://x220:8317`) |
| `MODELS_API_KEY`    | override for the model server key (default: `~/.pi/agent/x220-api-key`) |
| `AGENTMAIL_API_KEY` | override for the agentmail skill (default: `config.json`) |
| `AGENTMAIL_INBOX`   | override for the agentmail skill inbox               |

On this machine `NOVITA_API_KEY` lives in `~/.bash_aliases`. Replace the value
with your own — do not commit the real key.

---

## 5. Extensions

Extensions live in `~/.pi/agent/extensions/`. This setup uses three:

- **`fetch-models-x220.ts`** — fetches the model catalog from the local
  OpenAI-compatible proxy at `http://x220:8317` and registers it as the `x220`
  provider. Auto-registers at startup; `/fetch` re-queries the catalog on
  demand. Also reads `~/.pi/agent/x220-api-key` for the proxy key.
- **`pi-ask.ts`** — `/ask` command: the model answers from the codebase using
  read-only tools only (`read`, `grep`, `find`, `ls`, `bash` with a safe
  allowlist, plus `web_search`), then exits — no state-modifying access.
- **`autofile.ts`** — `@path` autocompletion in the editor; `@file` references
  are expanded inline with the file content before sending.

(herdr and orca managed extensions are installed by their own tools and are not
part of this repo's `extensions/`.)

The `settings.json` `packages` array pulls in these pi packages/extensions
automatically on first run:

- `npm:pi-delete-session`
- `npm:pi-web-access` (with all its extensions)
- `npm:@tintinweb/pi-subagents`
- `npm:pi-hermes-memory`
- `npm:@narumitw/pi-plan-mode`
- `npm:pi-openwiki`
- `npm:pi-mcp-adapter`
- `npm:context-mode`
- `../../build/playwright-bot-bypass` — **machine-specific local path** on this
  box; remove or replace with your own path on a fresh machine.

Resolved versions are recorded in `npm/package.json.reference`.

---

## 6. Skills

Skills live in `~/.pi/agent/skills/`. This setup uses one:

- **`agentmail/`** — compose and send email through AgentMail
  (api.agentmail.to). Requires `python3` (stdlib only). `send_mail.py` is
  dry-run by default and only sends with an explicit `--yes` after user
  approval. See `skills/agentmail/SKILL.md`.

---

## 7. First run

```bash
pi
```

On first launch pi will:
1. Install the packages listed in `settings.json`.
2. Load extensions from `~/.pi/agent/extensions/`.
3. Register the `x220` provider via `fetch-models-x220.ts` and the `deepseek`
   provider via `auth.json`.

Useful commands:

```bash
pi --list-models                       # list configured models
/fetch                                 # (in pi) refresh the x220 catalog
/ask "question about the codebase"     # read-only Q&A
```

---

## 8. Current provider / model defaults

From `settings.json`:

- `defaultProvider`: `x220`
- `defaultModel`: `oc-deepseek-v4-flash`
- `defaultThinkingLevel`: `high`
- `theme`: `dark`
- `hideThinkingBlock`: `true`

The `x220` provider (`http://x220:8317/v1`) currently exposes 25 models,
including `gpt-5.6-terra/luna/sol`, `gpt-5.5`, `gpt-5.4`, `claude-opus-4-6`,
`claude-sonnet-4-6`, `gemini-3.x` variants, `deepseek` variants, and
image models — see `config/models.json` for the full snapshot. Refresh the list
any time with `/fetch`.

---

## 9. Restoring on a fresh machine (tl;dr)

```bash
# Fastest: let the script do everything below, then fill in your secrets
./setup.sh

# ...or manually:
# 1. Node + npm (Section 1)
# 2. Install pi (Section 2)
npm config set prefix '~/.npm-global'
npm install -g @earendil-works/pi-coding-agent
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc

# 3. Config + extensions + skills (Section 3)
mkdir -p ~/.pi/agent/extensions ~/.pi/agent/skills
cp config/settings.json ~/.pi/agent/settings.json
cp config/trust.json    ~/.pi/agent/trust.json
cp extensions/*.ts      ~/.pi/agent/extensions/
cp -r skills/*          ~/.pi/agent/skills/
cp config/auth.json.template ~/.pi/agent/auth.json   # fill in keys

# 4. Env vars (Section 4) — add your keys to ~/.bashrc / ~/.bash_aliases
#    (NOVITA_API_KEY, AGENTMAIL_API_KEY/INBOX, and edit skills/agentmail/config.json)

# 5. Go
pi
```
