/** Preserve transport causes without exposing credentials in persisted diagnostics. */
export function describeNetworkError(error: unknown, secrets: string[] = []): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (value == null || depth > 4 || parts.length >= 12 || seen.has(value)) return;
    seen.add(value);
    if (typeof value === 'object') {
      const e = value as { message?: unknown; code?: unknown; cause?: unknown; errors?: unknown };
      const message = typeof e.message === 'string' ? e.message : '';
      const code = typeof e.code === 'string' ? e.code : '';
      const detail = message && code && !message.includes(code) ? `${message} [${code}]` : message || code;
      if (detail && !parts.includes(detail)) parts.push(detail);
      visit(e.cause, depth + 1);
      if (Array.isArray(e.errors)) for (const child of e.errors.slice(0, 8)) visit(child, depth + 1);
    } else {
      const detail = String(value);
      if (!parts.includes(detail)) parts.push(detail);
    }
  };
  visit(error, 0);
  let text = parts.length ? parts.join('; caused by ') : String(error);
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
  text = text
    .replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi, (url) => url.replace(/[?#].*$/, '?[REDACTED]').replace(/^((?:https?|wss?):\/\/)[^/]*@/i, '$1[REDACTED]@'))
    .replace(/\b(?:set-)?cookie["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\r\n]+)/gi, 'cookie: [REDACTED]')
    .replace(/\b(?:proxy-)?authorization["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\r\n;,}]+)/gi, 'authorization: [REDACTED]')
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
    .replace(/(["']?\b(?:api[-_]?key|access[-_]?key|secret|key|(?:access[-_]?|refresh[-_]?)token|password)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}\]]+)/gi, '$1[REDACTED]');
  return text.length > 2000 ? `${text.slice(0, 1999)}…` : text;
}
