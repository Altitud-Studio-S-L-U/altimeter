import type { Scenario } from '../support/scenario.ts';
import aiCrawlersBlocked from './ai-crawlers-blocked.ts';
import consentProblems from './consent-problems.ts';
import cruxNoData from './crux-no-data.ts';
import deliveryProblems from './delivery-problems.ts';
import faqNotVisible from './faq-not-visible.ts';
import headerConflicts from './header-conflicts.ts';
import hiddenText from './hidden-text.ts';
import imageProblems from './image-problems.ts';
import jsOnlyContent from './js-only-content.ts';
import lcpLazy from './lcp-lazy.ts';
import legalInSitemap from './legal-in-sitemap.ts';
import localeAdaptive from './locale-adaptive.ts';
import localeRedirects from './locale-redirects.ts';
import localeUnreachable from './locale-unreachable.ts';
import markupMismatch from './markup-mismatch.ts';
import mediaProblems from './media-problems.ts';
import pageStructure from './page-structure.ts';
import sitemapMissing from './sitemap-missing.ts';
import studioCrawl from './studio-crawl.ts';
import studioEs from './studio-es.ts';
import studioHome from './studio-home.ts';
import studioPolished from './studio-polished.ts';
import studioRoot from './studio-root.ts';
import studioService from './studio-service.ts';
import thinService from './thin-service.ts';
import transportProblems from './transport-problems.ts';

/** Every scenario, in the order the benchmark runs them: the studio as the tuned site serves it, then the real problems. */
export const scenarios: readonly Scenario[] = [
  studioHome, studioRoot, studioService, studioEs, studioCrawl, studioPolished,
  localeRedirects, localeUnreachable, localeAdaptive, sitemapMissing, markupMismatch, faqNotVisible, imageProblems, lcpLazy, legalInSitemap,
  consentProblems, pageStructure, hiddenText, jsOnlyContent, deliveryProblems, thinService, mediaProblems, aiCrawlersBlocked, headerConflicts,
  transportProblems, cruxNoData,
];
