import type { EvidenceItem } from '../core/evidence.ts';
import caLabels from './ca/evidence.json' with { type: 'json' };
import enLabels from './en/evidence.json' with { type: 'json' };
import esLabels from './es/evidence.json' with { type: 'json' };
import { format } from './format.ts';
import type { Language } from './messages.ts';
import { localizeParams } from './values.ts';

export type LabelCatalog = Readonly<Record<string, string>>;

/**
 * Evidence label templates keyed by their English template. The English catalog lists every template the source
 * uses (`npm run i18n:labels` writes it); a template missing from Spanish or Catalan is shown in English.
 */
export const labelCatalogs: Readonly<Record<Language, LabelCatalog>> = { en: enLabels, es: esLabels, ca: caLabels };

/**
 * An evidence label in `language`: each template translated, with the English words in its values translated too,
 * and each template without a translation kept in English with its values as they are.
 */
export function evidenceLabelText(language: Language, item: Pick<EvidenceItem, 'label' | 'labelParts'>, catalog: LabelCatalog = labelCatalogs[language]): string {
  if (language === 'en') return item.label;
  if (!item.labelParts) return catalog[item.label] ?? item.label;
  return item.labelParts.map(part => {
    const template = catalog[part.template];
    if (template === undefined) return format(part.template, part.params);
    return format(template, part.params === undefined ? undefined : localizeParams(language, part.params));
  }).join(' ');
}
