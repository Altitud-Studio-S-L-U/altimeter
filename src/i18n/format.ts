const placeholder = /\{([a-zA-Z][a-zA-Z0-9]*)\}/gu;

/** The placeholder names of a template, sorted, with repeats. */
export function placeholders(template: string): string[] {
  return [...template.matchAll(placeholder)].map(match => match[1]!).sort();
}

/**
 * Fills a template. Values are inserted as plain text; escaping for HTML or Markdown is the renderer's job.
 * A missing value leaves the placeholder visible rather than inventing text.
 */
export function format(template: string, params: Readonly<Record<string, string | number>> = {}): string {
  return template.replace(placeholder, (match, name: string) => (params[name] === undefined ? match : String(params[name])));
}
