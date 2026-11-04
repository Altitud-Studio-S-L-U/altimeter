import type { Category } from '../core/types.ts';
import enAi from './en/rules/ai.json' with { type: 'json' };
import enContent from './en/rules/content.json' with { type: 'json' };
import enCrawl from './en/rules/crawl.json' with { type: 'json' };
import enIntl from './en/rules/intl.json' with { type: 'json' };
import enPerf from './en/rules/perf.json' with { type: 'json' };
import enSchema from './en/rules/schema.json' with { type: 'json' };
import enTech from './en/rules/tech.json' with { type: 'json' };

export const languages = ['en', 'es', 'ca'] as const;
export type Language = (typeof languages)[number];

/**
 * Per-rule message templates. `messages.fail` is required for every implemented rule; `fail:<reason>` overrides it
 * for a failure variant. Placeholders are `{name}` and must match the params the rule emits. Spanish and Catalan
 * entries also translate the catalog's title, why and fix.
 */
export interface RuleMessages {
  readonly title?: string;
  readonly why?: string;
  readonly fix?: string;
  readonly messages: Readonly<Record<string, string>>;
}

export type MessageCatalog = Readonly<Record<string, RuleMessages>>;

const english: Readonly<Record<Category, MessageCatalog>> = {
  ai: enAi, content: enContent, crawl: enCrawl, intl: enIntl, perf: enPerf, schema: enSchema, tech: enTech,
} as Readonly<Record<Category, MessageCatalog>>;

const catalogs: Partial<Record<Language, MessageCatalog>> = {
  en: Object.assign({}, ...Object.values(english)) as MessageCatalog,
};

export function registerLanguage(language: Language, messages: MessageCatalog): void {
  catalogs[language] = messages;
}

export function messagesFor(language: Language): MessageCatalog {
  return catalogs[language] ?? catalogs.en!;
}

const placeholder = /\{([a-zA-Z][a-zA-Z0-9]*)\}/gu;

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

/** The message for a finding in `language`, falling back to English and then to `fail`. */
export function findingMessage(language: Language, ruleId: string, outcome: string, reason: string | undefined, params?: Readonly<Record<string, string | number>>): string | undefined {
  for (const catalog of [messagesFor(language), messagesFor('en')]) {
    const entry = catalog[ruleId];
    if (!entry) continue;
    const template = (reason ? entry.messages[`${outcome}:${reason}`] : undefined) ?? entry.messages[outcome];
    if (template !== undefined) return format(template, params);
  }
  return undefined;
}
