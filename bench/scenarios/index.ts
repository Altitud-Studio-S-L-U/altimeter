import type { Scenario } from '../support/scenario.ts';
import aiCrawlersBlocked from './ai-crawlers-blocked.ts';
import consentProblems from './consent-problems.ts';
import cruxNoData from './crux-no-data.ts';
import deliveryProblems from './delivery-problems.ts';
import faqNotVisible from './faq-not-visible.ts';
import headerConflicts from './header-conflicts.ts';
import hiddenText from './hidden-text.ts';
import holdoutAiRobotsInherited from './holdout-ai-robots-inherited.ts';
import holdoutAiRobotsNamed from './holdout-ai-robots-named.ts';
import holdoutBlog from './holdout-blog.ts';
import holdoutCanonicalConflict from './holdout-canonical-conflict.ts';
import holdoutHeadJs from './holdout-head-js.ts';
import holdoutHeadPixel from './holdout-head-pixel.ts';
import holdoutHreflangCrossLanguage from './holdout-hreflang-cross-language.ts';
import holdoutHreflangInvalid from './holdout-hreflang-invalid.ts';
import holdoutHreflangRegional from './holdout-hreflang-regional.ts';
import holdoutLabField from './holdout-lab-field.ts';
import holdoutLegacyHost from './holdout-legacy-host.ts';
import holdoutMixedContent from './holdout-mixed-content.ts';
import holdoutMixedUpgraded from './holdout-mixed-upgraded.ts';
import holdoutNoindexBlocked from './holdout-noindex-blocked.ts';
import holdoutNoindexJs from './holdout-noindex-js.ts';
import holdoutRobotsDirectives from './holdout-robots-directives.ts';
import holdoutRobotsRedirected from './holdout-robots-redirected.ts';
import holdoutShop from './holdout-shop.ts';
import holdoutTemplateLeftovers from './holdout-template-leftovers.ts';
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
import studioLab from './studio-lab.ts';
import studioPolished from './studio-polished.ts';
import studioRoot from './studio-root.ts';
import studioService from './studio-service.ts';
import thinService from './thin-service.ts';
import transportProblems from './transport-problems.ts';

/**
 * Every scenario, in the order the benchmark runs them: the studio as the tuned site serves it, then the real problems,
 * then the hold-out set written from the catalog text alone.
 */
export const scenarios: readonly Scenario[] = [
  studioHome, studioRoot, studioService, studioEs, studioCrawl, studioPolished, studioLab,
  localeRedirects, localeUnreachable, localeAdaptive, sitemapMissing, markupMismatch, faqNotVisible, imageProblems, lcpLazy, legalInSitemap,
  consentProblems, pageStructure, hiddenText, jsOnlyContent, deliveryProblems, thinService, mediaProblems, aiCrawlersBlocked, headerConflicts,
  transportProblems, cruxNoData,
  holdoutAiRobotsNamed, holdoutAiRobotsInherited, holdoutRobotsDirectives, holdoutRobotsRedirected, holdoutLegacyHost, holdoutNoindexBlocked,
  holdoutHeadPixel, holdoutHeadJs, holdoutNoindexJs, holdoutCanonicalConflict, holdoutHreflangInvalid, holdoutHreflangRegional,
  holdoutHreflangCrossLanguage, holdoutMixedContent, holdoutMixedUpgraded, holdoutTemplateLeftovers, holdoutBlog, holdoutShop, holdoutLabField,
];
