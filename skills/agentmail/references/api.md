# AgentMail API Reference

Base URL: `https://api.agentmail.to`
Version: `v0`

## Send a message

```
POST /v0/inboxes/{inbox}/messages/send
Authorization: Bearer {api_key}
Content-Type: application/json
```

### Request body

| Field | Type | Notes |
|-------|------|-------|
| `to` | string \| string[] | Recipient address(es) |
| `subject` | string | Required |
| `text` | string | Plain-text body |
| `html` | string | HTML body (alternative to `text`) |
| `cc` | string \| string[] | Optional |
| `bcc` | string \| string[] | Optional |
| `from_name` | string | Optional display name |
| `attachments` | array | Each: `filename`, `content_type`, `content` (base64), `content_disposition` |

### Attachment object

```json
{
  "filename": "report.pdf",
  "content_type": "application/pdf",
  "content": "<base64>",
  "content_disposition": "attachment"
}
```

### Example (raw curl)

```bash
PDF_B64=$(base64 -i report.pdf | tr -d '\n')
curl -s -X POST "https://api.agentmail.to/v0/inboxes/YOUR_AGENTMAIL_INBOX@agentmail.to/messages/send" \
  -H "Authorization: Bearer $AGENTMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"to\": \"hr@company.com\",
    \"subject\": \"Application\",
    \"text\": \"Please find my document attached.\",
    \"attachments\": [{
      \"filename\": \"report.pdf\",
      \"content_type\": \"application/pdf\",
      \"content\": \"$PDF_B64\",
      \"content_disposition\": \"attachment\"
    }]
  }"
```

### Success response

```json
{
  "message_id": "...",
  "thread_id": "..."
}
```
