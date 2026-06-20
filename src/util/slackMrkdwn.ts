/**
 * Escape Slack mrkdwn control characters in UNTRUSTED text (ClickUp task names,
 * status labels, resolved/unresolved assignee text, and the outbound task
 * preview). Without this, text like `<!channel>`, `<@U123>`, or `<url|text>`
 * would trigger pings or spoofed links when posted. Order matters: `&` must be
 * escaped first. Per Slack guidance only `&`, `<`, `>` are special in message
 * text.
 *
 * Lives in a shared util so both the inbound (clickup/webhook) and outbound
 * (slack/blocks) layers use the same escape without a slack→clickup import.
 */
export function escapeSlackText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
