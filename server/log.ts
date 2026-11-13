/**
 * One JSON object per line on stdout, collected by journald. Query with
 * `journalctl --user _SYSTEMD_USER_UNIT=bell-personal.service -o cat | jq -R 'fromjson? // .'`
 * (-R and fromjson? keep non-JSON lines, such as a crash's stack trace, from stopping jq).
 * Never pass request bodies, source text, credentials or model output here.
 */
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  if (process.env.BELLPERSONAL_LOG === "off") return;
  try {
    process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`);
  } catch {
    // Logging must never break a request.
  }
}
