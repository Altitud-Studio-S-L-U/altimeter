import type { Category } from '../core/types.ts';
import caAi from './ca/rules/ai.json' with { type: 'json' };
import caContent from './ca/rules/content.json' with { type: 'json' };
import caCrawl from './ca/rules/crawl.json' with { type: 'json' };
import caIntl from './ca/rules/intl.json' with { type: 'json' };
import caPerf from './ca/rules/perf.json' with { type: 'json' };
import caSchema from './ca/rules/schema.json' with { type: 'json' };
import caTech from './ca/rules/tech.json' with { type: 'json' };
import enAi from './en/rules/ai.json' with { type: 'json' };
import enContent from './en/rules/content.json' with { type: 'json' };
import enCrawl from './en/rules/crawl.json' with { type: 'json' };
import enIntl from './en/rules/intl.json' with { type: 'json' };
import enPerf from './en/rules/perf.json' with { type: 'json' };
import enSchema from './en/rules/schema.json' with { type: 'json' };
import enTech from './en/rules/tech.json' with { type: 'json' };
import esAi from './es/rules/ai.json' with { type: 'json' };
import esContent from './es/rules/content.json' with { type: 'json' };
import esCrawl from './es/rules/crawl.json' with { type: 'json' };
import esIntl from './es/rules/intl.json' with { type: 'json' };
import esPerf from './es/rules/perf.json' with { type: 'json' };
import esSchema from './es/rules/schema.json' with { type: 'json' };
import esTech from './es/rules/tech.json' with { type: 'json' };
import { format, placeholders } from './format.ts';
import { localizeParams } from './values.ts';

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

/** Message catalogs per language and category; a rule missing from Spanish or Catalan falls back to English. */
export const catalogsByCategory: Readonly<Record<Language, Readonly<Record<Category, MessageCatalog>>>> = {
  en: { ai: enAi, content: enContent, crawl: enCrawl, intl: enIntl, perf: enPerf, schema: enSchema, tech: enTech },
  es: { ai: esAi, content: esContent, crawl: esCrawl, intl: esIntl, perf: esPerf, schema: esSchema, tech: esTech },
  ca: { ai: caAi, content: caContent, crawl: caCrawl, intl: caIntl, perf: caPerf, schema: caSchema, tech: caTech },
} as Readonly<Record<Language, Readonly<Record<Category, MessageCatalog>>>>;

const catalogs: Partial<Record<Language, MessageCatalog>> = Object.fromEntries(
  languages.map(language => [language, Object.assign({}, ...Object.values(catalogsByCategory[language])) as MessageCatalog]),
);

export function registerLanguage(language: Language, messages: MessageCatalog): void {
  catalogs[language] = messages;
}

export function messagesFor(language: Language): MessageCatalog {
  return catalogs[language] ?? catalogs.en!;
}

export { format, placeholders };

/**
 * The message for a finding in `language`, falling back to English and then to `fail`. A translated template also
 * gets the English words that code wrote into its values translated; the English template keeps them as they are.
 */
export function findingMessage(language: Language, ruleId: string, outcome: string, reason: string | undefined, params?: Readonly<Record<string, string | number>>): string | undefined {
  for (const catalogLanguage of language === 'en' ? ['en' as const] : [language, 'en' as const]) {
    const entry = messagesFor(catalogLanguage)[ruleId];
    if (!entry) continue;
    const template = (reason ? entry.messages[`${outcome}:${reason}`] : undefined) ?? entry.messages[outcome];
    if (template !== undefined) return format(template, params && catalogLanguage !== 'en' ? localizeParams(catalogLanguage, params, ruleId) : params);
  }
  return undefined;
}

export interface RuleTexts {
  readonly title: string;
  readonly why: string;
  readonly fix: string;
}

/** A rule's title, why and fix in `language`, falling back to the catalog's English text. */
export function ruleTexts(language: Language, rule: { readonly id: string; readonly title: string; readonly why: string; readonly fix: string }): RuleTexts {
  const entry = language === 'en' ? undefined : messagesFor(language)[rule.id];
  return { title: entry?.title ?? rule.title, why: entry?.why ?? rule.why, fix: entry?.fix ?? rule.fix };
}
