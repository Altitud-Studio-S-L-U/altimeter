import { defineScenario } from '../support/scenario.ts';
import { studioHosts, studioSite } from '../support/studio.ts';

const page = '/es/';

export default defineScenario({
  name: 'studio-es',
  summary: 'The Spanish home: language signals, hreflang and metadata of a translated locale that the cookie-less root never redirects to.',
  hosts: studioHosts,
  build: context => studioSite(context, page),
  mustFail: [],
  mustNotFail: [
    { rule: 'intl-html-lang-missing-or-invalid', page }, { rule: 'intl-html-lang-vs-content', page }, { rule: 'intl-hreflang-value-vs-content-language', page },
    { rule: 'intl-mixed-language-page', page }, { rule: 'intl-metadata-translation-parity', page }, { rule: 'intl-og-locale', page },
    'intl-untranslated-variant', 'intl-localized-urls-unreachable', 'intl-auto-redirect-by-language', 'intl-hreflang-missing-return-link',
    { rule: 'intl-language-switcher-crawlable', page }, { rule: 'content-title-width', page }, { rule: 'content-keyword-stuffing', page },
    { rule: 'content-heading-level-skips', page }, { rule: 'content-hidden-text', page }, 'schema-inlanguage',
  ],
});
