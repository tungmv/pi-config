---
name: agentmail
description: Compose and send email through AgentMail (api.agentmail.to) using the user's own API key/inbox. Generic "write mail" tool — supports plain-text or HTML body, CC/BCC, and any file attachments. Use whenever the user wants to draft or send an email, application, follow-up, or any message from their AgentMail account.
---

# AgentMail — Write & Send Mail

A generic email-composing skill that sends mail through the user's **AgentMail**
account. It has **no knowledge of the user's job, career, or IT skills** — it only
writes and sends the message you ask it to. The agent (you) composes the content;
this skill provides the reliable send mechanism and credential handling.

> Scope: this skill ONLY writes/sends mail via the AgentMail API. It does not
> generate resumes, parse job descriptions, or remember anything about the user's
> profession. Every email is composed fresh from the user's request.

> 🛑 **MANDATORY — NEVER SEND WITHOUT EXPLICIT USER CONFIRMATION.**
> You MUST first run the script *without* `--yes` (a dry run that prints the full
draft), show the draft to the user (recipient, subject, body, attachments), and
wait for the user's explicit approval. Only after approval may you re-run with
`--yes` to actually deliver. Do not skip this step, do not add `--yes`
preemptively, and never send "just to show" the user — a dry run already shows it.
> The user has been clear: no email leaves their account without confirmation.

---

## Credentials (resolved automatically)

The API key and inbox are resolved in this order:

1. CLI flag (`--api-key`, `--inbox`)
2. `config.json` in this skill directory (already preset to the user's account)
3. Environment variable (`AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX`)

No action is needed by the user unless they want to override the default account.

---

## How to send mail

Use the bundled script `scripts/send_mail.py` (standard library only — no pip
install required).

### Basic text email

```bash
python3 scripts/send_mail.py \
  --to "hr@company.com" \
  --subject "Follow-up on application" \
  --body "Hi, just following up on my application. Thanks!"
```

### Multiple recipients, CC, and attachments

```bash
python3 scripts/send_mail.py \
  --to "alice@x.com,bob@y.com" \
  --cc "manager@x.com" \
  --subject "Quarterly update" \
  --body "Please find the report attached." \
  --attachment "report.pdf" \
  --attachment "data.csv"
```

### HTML email

```bash
python3 scripts/send_mail.py \
  --to "team@x.com" \
  --subject "Release notes" \
  --html "<h1>v2.0 shipped</h1><p>See the <a href='https://...'>changelog</a>.</p>"
```

### Override the sender account (optional)

```bash
python3 scripts/send_mail.py --to "x@y.com" --subject "S" --body "B" \
  --inbox "other@agentmail.to" --api-key "am_us_..."
```

---

## Argument reference — `send_mail.py`

| Flag | Required | Description |
|------|----------|-------------|
| `--to` | ✅ | Recipient(s), comma-separated for multiple |
| `--subject` | ✅ | Email subject line |
| `--body` / `--text` | ✅* | Plain-text body (*required unless `--html` given) |
| `--html` | ⬜ | HTML body; used instead of `--body` when provided |
| `--attachment` | ⬜ | Path to a file to attach; repeatable; any file type |
| `--cc` | ⬜ | CC recipient(s), comma-separated |
| `--bcc` | ⬜ | BCC recipient(s), comma-separated |
| `--api-key` | ⬜ | Override AgentMail API key |
| `--inbox` | ⬜ | Override sender inbox/address |
| `--yes` / `--confirm` | ⬜* | **Required to actually send.** Without it the script only prints a draft and exits (dry run). *Never pass this unless the user has explicitly approved the draft. |

Attachments are auto base64-encoded; the content type is guessed from the file
extension (falls back to `application/octet-stream`).

---

## Workflow for the agent

1. **Compose** the message from the user's request — subject, recipients, and body
   (plain text or HTML). You are responsible for the wording; the skill only sends.
2. **Attach** files if the user wants them included (pass one `--attachment` per file).
3. **Dry-run (REQUIRED)** — run the script **without** `--yes`. It prints the full
   draft and sends nothing. Show this draft to the user.
4. **Wait for approval** — do NOT proceed until the user explicitly says to send.
5. **Send** — only after approval, re-run the exact same command with `--yes`
   appended. Confirm success from the printed `Message ID`.
6. **Report** the result to the user (recipients, subject, attachments, message id).

> Why the dry-run gate: a plain call can NEVER deliver mail (the script exits
> before sending unless `--yes` is present). This makes an accidental send
> impossible — the worst case without approval is a printed draft, not a sent email.

Do **not** embed or assume any personal job/IT details — write exactly what the
user asks. If the user wants a resume or job-specific content, they will provide
it; this skill just delivers the mail.

See `references/api.md` for the underlying AgentMail REST endpoint.
