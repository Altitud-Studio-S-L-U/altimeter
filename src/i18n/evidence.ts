import type { EvidenceItem } from '../core/evidence.ts';
import caLabels from './ca/evidence.json' with { type: 'json' };
import enLabels from './en/evidence.json' with { type: 'json' };
import esLabels from './es/evidence.json' with { type: 'json' };
import { format } from './format.ts';
import type { Language } from './messages.ts';
import { isCatalogWord, localizeParams, localizeValue } from './values.ts';

export type LabelCatalog = Readonly<Record<string, string>>;

/**
 * Evidence label templates keyed by their English template. The English catalog lists every template the source
 * uses (`npm run i18n:labels` writes it); a template missing from Spanish or Catalan is shown in English.
 */
export const labelCatalogs: Readonly<Record<Language, LabelCatalog>> = { en: enLabels, es: esLabels, ca: caLabels };

/**
 * Whether every part of a label is a template this version writes. One that is not comes from an edited report.json
 * or another version: it is never read as a template, and the English text the report stored stands for the label.
 */
function knownTemplates(item: Pick<EvidenceItem, 'labelParts'>): boolean {
  return (item.labelParts ?? []).every(part => labelCatalogs.en[part.template] !== undefined);
}

/**
 * An evidence label in `language`: each template translated, with the English words in its values translated too,
 * and each template without a translation kept in English with its values as they are.
 */
export function evidenceLabelText(language: Language, item: Pick<EvidenceItem, 'label' | 'labelParts'>, catalog: LabelCatalog = labelCatalogs[language]): string {
  if (language === 'en') return item.label;
  if (!item.labelParts) return catalog[item.label] ?? item.label;
  if (!knownTemplates(item)) return item.label;
  return item.labelParts.map(part => {
    const template = catalog[part.template];
    if (template === undefined) return format(part.template, part.params);
    return format(template, part.params === undefined ? undefined : localizeParams(language, part.params), language);
  }).join(' ');
}

/**
 * An evidence label as evidenceLabelText writes it, with every value that is data rather than a word of the value
 * catalog, such as a URL, an id or text from the site, passed through `quote`. A label with a template that the English
 * catalog does not have comes from an edited report.json or another version, so its stored text is quoted whole.
 */
export function quotedEvidenceLabel(language: Language, item: Pick<EvidenceItem, 'label' | 'labelParts'>, quote: (value: string) => string, catalog: LabelCatalog = labelCatalogs[language]): string {
  if (!item.labelParts) return labelCatalogs.en[item.label] === undefined ? quote(item.label) : evidenceLabelText(language, item, catalog);
  if (!knownTemplates(item)) return quote(item.label);
  return item.labelParts.map(part => {
    const translation = language === 'en' ? undefined : catalog[part.template];
    const values = Object.fromEntries(Object.entries(part.params ?? {}).map(([name, value]) => {
      if (typeof value === 'number') return [name, value];
      const shown = translation === undefined ? value : localizeValue(language, name, value);
      return [name, isCatalogWord(name, value) ? shown : quote(shown)];
    }));
    return format(translation ?? part.template, values, translation === undefined ? 'en' : language);
  }).join(' ');
}
