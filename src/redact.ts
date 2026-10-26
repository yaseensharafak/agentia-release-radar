/**
 * Remove secrets and personal data from text before it is printed, posted to Slack, or sent to an AI agent.
 * Copado error messages can include the full request URL with ?api_key=..., so this runs on every error we surface.
 */
export function redact(text: string): string {
  return text
    .replace(/\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._-]{20,}/g, '[REDACTED_SESSION]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED]')
    .replace(
      /((?:access_token|refresh_token|password|passwd|secret|api[_-]?key|sessionid)\s*[=:]\s*)["']?[^\s"',;&]+/gi,
      '$1[REDACTED]',
    )
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[EMAIL]');
}
