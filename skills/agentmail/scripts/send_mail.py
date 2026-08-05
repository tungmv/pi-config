#!/usr/bin/env python3
"""
Send an email through AgentMail (https://agentmail.to) — no job/IT knowledge
required. This is a generic "write mail" tool: compose a message and (optionally)
attach any files, then send it from your AgentMail inbox.

Credentials are resolved in this order:
  1. CLI flag (--api-key / --inbox)
  2. config.json in this skill directory
  3. Environment variable (AGENTMAIL_API_KEY / AGENTMAIL_INBOX)

SAFETY: This script NEVER sends mail unless --yes is explicitly passed. A plain
call performs a DRY RUN — it prints the full draft and exits without transmitting
anything. The agent must present the draft to the user, get explicit approval,
and only THEN re-run with --yes.

Usage:
    # Draft only (safe — nothing is sent):
    python3 send_mail.py --to hr@company.com --subject "Hi" --body "Hello"

    # Actually send (only after the user approved the draft above):
    python3 send_mail.py --to hr@company.com --subject "Hi" --body "Hello" --yes

    python3 send_mail.py --to a@x.com,b@y.com --subject "S" --body "B" \
        --attachment resume.pdf --attachment notes.txt --cc boss@x.com --yes
"""

import argparse
import base64
import configparser
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request

# Resolve this script's directory so config.json is found regardless of cwd.
SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(SKILL_DIR, "config.json")


def load_config() -> dict:
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f).get("agentmail", {})
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as e:
        print(f"⚠️  Could not parse config.json: {e}", file=sys.stderr)
        return {}


def resolve(key: str, cli_value: str | None, config: dict, env_var: str | None) -> str:
    """Precedence: CLI flag > config.json > environment variable."""
    if cli_value:
        return cli_value
    if config.get(key):
        return config[key]
    if env_var and os.environ.get(env_var):
        return os.environ[env_var]
    return ""


def guess_content_type(path: str) -> str:
    ctype, _ = mimetypes.guess_type(path)
    return ctype or "application/octet-stream"


def build_attachment(path: str) -> dict:
    if not os.path.isfile(path):
        print(f"❌ Attachment not found: {path}", file=sys.stderr)
        sys.exit(1)
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("utf-8")
    return {
        "filename": os.path.basename(path),
        "content_type": guess_content_type(path),
        "content": b64,
        "content_disposition": "attachment",
    }


def send(
    *,
    api_base: str,
    api_version: str,
    api_key: str,
    inbox: str,
    to: list[str],
    subject: str,
    text: str | None,
    html: str | None,
    attachments: list[dict],
    cc: list[str] | None,
    bcc: list[str] | None,
    from_name: str | None,
) -> dict:
    payload: dict = {"to": to, "subject": subject}
    if text is not None:
        payload["text"] = text
    if html is not None:
        payload["html"] = html
    if attachments:
        payload["attachments"] = attachments
    if cc:
        payload["cc"] = cc
    if bcc:
        payload["bcc"] = bcc
    if from_name:
        payload["from_name"] = from_name

    url = f"{api_base.rstrip('/')}/{api_version}/inboxes/{inbox}/messages/send"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            print("✅ Email sent successfully!")
            print(f"   To:        {', '.join(to)}")
            if cc:
                print(f"   Cc:        {', '.join(cc)}")
            if attachments:
                print(f"   Attachments: {', '.join(a['filename'] for a in attachments)}")
            print(f"   Message ID: {result.get('message_id', 'N/A')}")
            print(f"   Thread  ID: {result.get('thread_id', 'N/A')}")
            return result
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"❌ HTTP {e.code}: {body}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"❌ Connection error: {e.reason}", file=sys.stderr)
        sys.exit(1)


def split_csv(value: str) -> list[str]:
    return [v.strip() for v in value.split(",") if v.strip()]


def print_draft(
    *,
    to: list[str],
    subject: str,
    text: str | None,
    html: str | None,
    attachments: list[dict],
    cc: list[str] | None,
    bcc: list[str] | None,
) -> None:
    """Render the email draft so the user can review it before approval."""
    print("=" * 60)
    print("📧  DRAFT (not sent)")
    print("=" * 60)
    print(f"To:          {', '.join(to)}")
    if cc:
        print(f"Cc:          {', '.join(cc)}")
    if bcc:
        print(f"Bcc:         {', '.join(bcc)}")
    print(f"Subject:     {subject}")
    if attachments:
        print(f"Attachments: {', '.join(a['filename'] for a in attachments)}")
    print("-" * 60)
    if html is not None:
        print("[HTML body]")
        print(html)
    else:
        print(text or "")
    print("=" * 60)


def main():
    parser = argparse.ArgumentParser(
        description="Compose and send an email via AgentMail (generic mail tool)."
    )
    parser.add_argument("--to", required=True, help="Recipient(s), comma-separated")
    parser.add_argument("--subject", required=True, help="Email subject")
    parser.add_argument("--body", "--text", dest="text", help="Plain-text body")
    parser.add_argument("--html", help="HTML body (used instead of --body if provided)")
    parser.add_argument(
        "--attachment", action="append", default=[],
        help="File to attach (repeatable, any type)",
    )
    parser.add_argument("--cc", help="CC recipient(s), comma-separated")
    parser.add_argument("--bcc", help="BCC recipient(s), comma-separated")
    parser.add_argument("--api-key", help="AgentMail API key override")
    parser.add_argument("--inbox", help="AgentMail inbox/sender address override")
    parser.add_argument(
        "--yes", "--confirm", action="store_true",
        help="REQUIRED to actually send. Without it the script only prints a "
             "draft and exits (dry run). Only pass this after the user has "
             "explicitly approved the draft.",
    )
    args = parser.parse_args()

    config = load_config()

    api_key = resolve("api_key", args.api_key, config, config.get("api_key_env"))
    inbox = resolve("inbox", args.inbox, config, config.get("inbox_env"))
    from_name = config.get("from_name") or None

    if not api_key:
        print(
            "❌ AgentMail API key required. Pass --api-key, set it in config.json, "
            "or export AGENTMAIL_API_KEY.",
            file=sys.stderr,
        )
        sys.exit(1)
    if not inbox:
        print(
            "❌ AgentMail inbox required. Pass --inbox, set it in config.json, "
            "or export AGENTMAIL_INBOX.",
            file=sys.stderr,
        )
        sys.exit(1)
    if not args.text and not args.html:
        print("❌ Provide a --body (or --html) for the email content.", file=sys.stderr)
        sys.exit(1)

    attachments = [build_attachment(p) for p in args.attachment]

    # SAFETY GATE: refuse to send unless the user (via the agent) explicitly
    # approved by passing --yes. A plain call is always a harmless dry run.
    if not args.yes:
        print_draft(
            to=split_csv(args.to),
            subject=args.subject,
            text=args.text,
            html=args.html,
            attachments=attachments,
            cc=split_csv(args.cc) if args.cc else None,
            bcc=split_csv(args.bcc) if args.bcc else None,
        )
        print("⚠️  DRY RUN — email was NOT sent.")
        print("    Review the draft above. Once the user approves, re-run with")
        print("    --yes to actually deliver the message.")
        sys.exit(0)

    send(
        api_base=config.get("api_base", "https://api.agentmail.to"),
        api_version=config.get("api_version", "v0"),
        api_key=api_key,
        inbox=inbox,
        to=split_csv(args.to),
        subject=args.subject,
        text=args.text,
        html=args.html,
        attachments=attachments,
        cc=split_csv(args.cc) if args.cc else None,
        bcc=split_csv(args.bcc) if args.bcc else None,
        from_name=from_name,
    )


if __name__ == "__main__":
    main()
