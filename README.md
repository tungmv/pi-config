# pi-config

How to set up [pi (pi-coding-agent)](https://github.com/earendil-works/pi-coding-agent)
**from scratch** to reproduce the current installation on this machine
(`tony@x220`, home dir `/home/tony`).

This repo contains:

```
README.md            # this guide
config/              # pi agent config files (secrets replaced with placeholders)
  settings.json
  models.json        # API key is a placeholder — fill in your own
  trust.json
  auth.json.template  # template for secrets; copy to ~/.pi/agent/auth.json
extensions/          # pi extensions (drop into ~/.pi/agent/extensions/)
  fetch-models-x220.ts
  hidden-thinking-label.ts
shell/               # shell snippets to source from ~/.bashrc
  bashrc.snippet
```

> The `x220` host name refers to this machine. If you are reproducing this on
> another box, replace `x220` with your hostname / model-server address
> everywhere (and in `fetch-models-x220.ts`).

---

## 1. Prerequisites

- A Linux machine (this setup was done on Arch-flavored `x220`).
- `git`, `curl`, and a working network connection.
- A model provider. This setup uses a local OpenAI-compatible server exposed at
  `http://x220:4000/v1` (the `x220` provider) plus Nova/DeepSeek keys via
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
pi --version   # 0.80.3
```

---

## 3. Authenticate / configure providers

pi stores agent state under `~/.pi/agent`. Create the directory and copy the
config files from this repo:

```bash
mkdir -p ~/.pi/agent/extensions
cp config/settings.json   ~/.pi/agent/settings.json
cp config/models.json     ~/.pi/agent/models.json
cp config/trust.json      ~/.pi/agent/trust.json
cp extensions/*.ts        ~/.pi/agent/extensions/
```

### Secrets — `auth.json`

`config/auth.json.template` shows the shape of `~/.pi/agent/auth.json`. Copy it
and fill in your real keys (do **not** commit the filled-in file):

```bash
cp config/auth.json.template ~/.pi/agent/auth.json
$EDITOR ~/.pi/agent/auth.json
```

This machine currently has a `deepseek` key set there. Keys placed in
`auth.json` are picked up by pi and used for the matching provider.

> `models.json` also contains an `apiKey` for the `x220` provider (the local
> server). In this repo it is replaced with the placeholder
> `YOUR_X220_API_KEY`. Put your real key into `~/.pi/agent/models.json`.

---

## 4. Environment variables

Shell environment variables used by pi / extensions (see
`shell/bashrc.snippet`):

| Variable            | Purpose                                              |
|---------------------|------------------------------------------------------|
| `PATH`              | must include `~/.npm-global/bin`                     |
| `NOVITA_API_KEY`    | API key for Novita (used by some `x220` models)      |
| `MODELS_SERVER_URL` | override for the model server URL (default `http://x220:4000`) |
| `MODELS_API_KEY`    | override for the model server key (default dummy `local`) |

On this machine `NOVITA_API_KEY` lives in `~/.bash_aliases`. Replace the value
with your own — do not commit the real key.

---

## 5. Extensions

Extensions live in `~/.pi/agent/extensions/`. This setup uses two:

- **`fetch-models-x220.ts`** — dynamically fetches available models from the
  local OpenAI-compatible server at `http://x220:4000` and registers them as
  the `x220` provider. Run pi with it via:

  ```bash
  pi -e ~/.pi/agent/extensions/fetch-models-x220.ts
  # or just list models:
  pi --list-models -e ~/.pi/agent/extensions/fetch-models-x220.ts
  ```

  Then pick a model with `/model` → `x220/<model-id>`.

- **`hidden-thinking-label.ts`** — customizes the label shown when thinking
  blocks are hidden (toggle with `Ctrl+T`). Provides the
  `/thinking-label <text>` command.

The `settings.json` `packages` array also pulls in these pi packages/extensions
automatically on first run:

- `npm:pi-delete-session`
- `npm:pi-web-access` (with all its extensions)
- `git:github.com/pasky/pi-session-summary`
- `npm:@tintinweb/pi-subagents`

---

## 6. First run

```bash
pi
```

On first launch pi will:
1. Install the packages listed in `settings.json`.
2. Load extensions from `~/.pi/agent/extensions/`.
3. Read `models.json` / `auth.json` for providers.

Useful commands:

```bash
pi --list-models                       # list configured models
pi -e ~/.pi/agent/extensions/fetch-models-x220.ts   # load the x220 fetcher
```

---

## 7. Current provider / model defaults

From `settings.json`:

- `defaultProvider`: `x220`
- `defaultModel`: `sf-hy3`
- `defaultThinkingLevel`: `high`
- `theme`: `dark`
- `hideThinkingBlock`: `true`

The `x220` provider (`http://x220:4000/v1`) currently exposes models such as
`nv-deepseek-v4-pro`, `nw-glm-5.2-flex`, `xah-claude-sonnet-5`,
`xah-gpt-5.5-xhigh`, and several free/flex variants — see `config/models.json`.

---

## 8. Restoring on a fresh machine (tl;dr)

```bash
# 1. Node + npm (Section 1)
# 2. Install pi (Section 2)
npm config set prefix '~/.npm-global'
npm install -g @earendil-works/pi-coding-agent
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc

# 3. Config + extensions (Section 3)
mkdir -p ~/.pi/agent/extensions
cp config/settings.json ~/.pi/agent/settings.json
cp config/models.json   ~/.pi/agent/models.json
cp config/trust.json    ~/.pi/agent/trust.json
cp extensions/*.ts      ~/.pi/agent/extensions/
cp config/auth.json.template ~/.pi/agent/auth.json   # fill in keys

# 4. Env vars (Section 4) — add your keys to ~/.bashrc / ~/.bash_aliases

# 5. Go
pi
```
