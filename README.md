## Boom SLA Check

Checks a Boom conversation for guest messages that haven't received an agent reply within the SLA window, and emails an alert.

### Secrets (already in your repo)
- BOOM_USER, BOOM_PASS
- SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
- ALERT_TO, ALERT_FROM_NAME
- (Optional) AGENT_SIDE — only used as a hint; classes from the DOM are primary.

### Run manually
Actions → **Boom SLA check** → Run workflow
- `conversation`: paste the full URL from Boom
- `sla_minutes` (optional): override default 10

### How it works
1. Opens the URL. If redirected to login, fills credentials and continues.
2. Collects **real** chat cards (`.v-card.elevation-0` + `.msg-box`) and discards any inside `.ai-component` (AI suggestions).
3. Determines **guest/agent** by bubble alignment classes.
4. Parses the timestamp under the bubble and computes minutes since.
5. Sends an email if: last sender is **guest** AND `minsAgo >= SLA_MIN`.

Artifacts uploaded to the run:
- `/tmp/boom-before.png` and `/tmp/boom-after.png`
- `/tmp/boom-dom.html`
- `/tmp/boom-messages.json` (what was analyzed)
