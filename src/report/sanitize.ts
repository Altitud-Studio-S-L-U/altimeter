/**
 * Text copied from an audited site is untrusted: it can carry control characters, bidirectional overrides that
 * disguise what a reader sees, terminal escape sequences, or instructions aimed at whoever reads the report,
 * including coding agents. These helpers neutralise it before it reaches a report, a task file or a terminal.
 */

// C0 and C1 controls except tab and line feed, bidirectional overrides and isolates, and zero-width characters.
const unsafeCharacters = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu;
const terminalEscapes = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-_])/gu;

export function cleanText(value: string, maxLength = 2000): string {
  const cleaned = value.replace(terminalEscapes, '').replace(unsafeCharacters, '').replace(/\r\n?/gu, '\n');
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}

/** A single line for tables, terminals and headings. */
export function cleanLine(value: string, maxLength = 300): string {
  return cleanText(value, maxLength).replace(/\s+/gu, ' ').trim();
}

/** A fenced Markdown block, labelled untrusted, whose fence is longer than any backtick run inside it. */
export function untrustedBlock(value: string, maxLength = 2000): string {
  const text = cleanText(value, maxLength);
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/gu)].map(match => match[0].length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}untrusted\n${text}\n${fence}`;
}

/** Inline code for short untrusted values inside Markdown prose and tables. */
export function untrustedInline(value: string, maxLength = 200): string {
  const text = cleanLine(value, maxLength).replace(/\|/gu, '\\|');
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/gu)].map(match => match[0].length));
  const fence = '`'.repeat(longestRun + 1);
  const padded = text.startsWith('`') || text.endsWith('`') ? ` ${text} ` : text;
  return text === '' ? '(empty)' : `${fence}${padded}${fence}`;
}

const htmlEscapes: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string): string {
  return cleanText(value, 100_000).replace(/[&<>"']/gu, character => htmlEscapes[character]!);
}

/** JSON safe to embed in a <script> element: no sequence can close the element or open a comment. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</gu, '\\u003c').replace(/>/gu, '\\u003e').replace(/&/gu, '\\u0026').replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029');
}
