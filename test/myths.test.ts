import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { myths, rule, rules } from '../src/catalog/index.ts';
import { matchedPatterns, mythMatches, normalizeMythText } from '../src/rules/myth-filter.ts';

const matchedIds = (text: string): string[] => mythMatches(text).map(myth => myth.id);

function describeMatches(text: string): string {
  return mythMatches(text).map(myth => `${myth.id} ${JSON.stringify(matchedPatterns(text, myth))}`).join('; ');
}

/** One recommendation per myth that repeats it, as an analyst could write it. */
const repeats: Record<string, string> = {
  'crawl-delay-google': 'Add a Crawl-delay for Googlebot in robots.txt so the server is not overloaded.',
  'robots-txt-noindex': 'Add a Noindex: line for /tmp/ in robots.txt to remove those pages from Google.',
  'disallow-removes-from-index': 'Disallow it in robots.txt to remove the staging copy from search results.',
  'noindex-saves-crawl-budget': 'Noindex these pages to save crawl budget for the important ones.',
  'sitemap-changefreq-priority': 'Set changefreq to daily and raise the sitemap priority of the product pages.',
  'sitemap-ping': 'Ping Google with the sitemap URL after every deploy.',
  'rel-next-prev': 'Add rel="next" and rel="prev" links to the paginated category pages.',
  'paginate-canonical-to-first': 'Point the canonical to the first page of the series on every paginated URL.',
  'canonical-is-directive': 'The canonical is a directive, so Google will index the URL you choose.',
  'google-cannot-index-js': "Google can't index JavaScript, so render the menu on the server.",
  'dynamic-rendering-recommended': 'Implement dynamic rendering for bots so Googlebot gets static HTML.',
  'googlebot-15mb': 'Googlebot indexes the first 15MB of HTML, so this 3 MB page is fine.',
  '404-hurts-rankings': 'These 404 errors hurt rankings; restore the old URLs.',
  '410-much-faster': 'Use 410 instead of 404 to deindex faster.',
  'redirect-deleted-to-home': 'Redirect all deleted pages to the homepage to keep their link equity.',
  '403-to-slow-googlebot': 'Return 403 to slow Googlebot during traffic peaks.',
  'noarchive-google': 'Add noarchive to stop Google from showing a cached copy of the pricing page.',
  'indexnow-for-google': 'Use IndexNow to get indexed by Google faster.',
  'http2-ranking-boost': 'Enable HTTP/2 for a ranking boost.',
  'robots-meta-only-in-head': 'The noindex in the body is ignored; move it up.',
  'fragments-crawled-separately': 'Use hashbang URLs (#!/page) so each view is crawled.',
  'title-description-length-limits': 'The title exceeds the 60-character limit; shorten it.',
  'titles-shown-as-written': 'Google always shows your title as written, so put the keyword first.',
  'one-h1-heading-order': 'Use only one H1 to rank; the page has three.',
  'minimum-word-count': 'This page needs at least 1,000 words to compete.',
  'keyword-density': 'Target keyword density of 2% for the main term.',
  'meta-keywords': 'Add a meta keywords tag with the main services.',
  'eeat-ranking-score': 'Improve your E-E-A-T score with author bios.',
  'raters-demote-sites': 'Quality raters can demote the site if the about page is thin.',
  'ai-content-penalised': 'Rewrite these articles by hand because Google penalizes AI content.',
  'duplicate-content-penalty': 'Consolidate the near-identical pages to avoid a duplicate content penalty.',
  'keywords-in-domain-url': 'Register an exact-match domain for the product line.',
  'update-dates-for-freshness': 'Update the publish date regularly so the post looks fresh.',
  'readability-score-ranking': 'Raise the Flesch score above 60 for better rankings.',
  'nofollow-external-links': 'Nofollow all external links to avoid leaking PageRank.',
  'tabs-hidden-text': 'Content in tabs is hidden text, so move the specs out of the accordion.',
  'llms-txt-for-ai-search': 'Add llms.txt for AI Overviews visibility.',
  'helpful-content-update-recovery': 'Prune thin posts and wait for the next helpful content update.',
  'alt-text-125-limit': 'Keep alt text under 125 characters.',
  'css-background-images-indexed': 'The hero is fine because CSS background images are indexed.',
  'title-separators-ranking': 'Use pipes instead of dashes to rank better.',
  'lighthouse-score-ranking': 'Improve the Lighthouse score to rank above competitors.',
  'page-experience-single-signal': 'Page experience is a single ranking signal, so fix it first.',
  'cwv-outranks-relevance': 'Fix LCP to avoid a Core Web Vitals penalty.',
  'fid-core-web-vital': 'Reduce First Input Delay by splitting the bundle.',
  'ttfb-fcp-core-web-vital': 'TTFB is a Core Web Vital, so it must be under 800 ms.',
  'lighthouse-measures-inp': 'The Lighthouse run shows good INP, so responsiveness is fine.',
  'lab-cls-proves-good': 'Lab CLS proves the layout is stable.',
  'lazy-load-everything': 'Add loading=lazy to all images, including the hero.',
  'no-store-blocks-bfcache': 'Cache-Control: no-store always blocks the bfcache, so drop it.',
  'unload-handlers-reliable': 'Use an unload handler to send the analytics beacon.',
  'isinputpending': 'Use navigator.isInputPending() to decide when to yield.',
  'preload-everything': 'Preload all fonts and preconnect to every third-party origin.',
  'removed-lighthouse-audits': 'Fix the uses-long-cache-ttl audit by setting long max-age values.',
  'single-lighthouse-run': 'A single Lighthouse run shows the page is fast.',
  'no-crux-means-problem': 'No CrUX data means a performance problem on this origin.',
  'cwv-averaged-across-devices': 'Core Web Vitals are averaged across mobile and desktop, so desktop offsets mobile.',
  'schema-boosts-rankings': 'Add schema markup to rank higher in local results.',
  'faqpage-rich-results': 'Add FAQPage markup to get FAQ rich results under the listing.',
  'howto-rich-results': 'Add HowTo schema to the guide to get how-to rich results.',
  'sitelinks-search-box': 'Add a SearchAction to get a sitelinks search box.',
  'jsonld-must-be-in-head': 'Move JSON-LD to the head; Google ignores it in the body.',
  'js-structured-data-invisible': "Hardcode the markup because Google can't see structured data injected by GTM.",
  'microdata-worse-than-jsonld': 'Convert Microdata to JSON-LD for rankings.',
  'rich-results-test-guarantees': 'The markup passes the Rich Results Test, which guarantees a rich result.',
  'special-schema-for-ai': 'Add structured data for AI Overviews so the page gets cited.',
  'self-serving-review-stars': 'Add AggregateRating to your Organization markup with your Google reviews.',
  'article-headline-110': 'Shorten the headline to 110 characters; longer ones are invalid.',
  'organization-on-every-page': 'Add Organization markup to every page via the layout.',
  'rich-results-test-validates-all': 'Validate site names with the Rich Results Test.',
  'unsupported-markup-harms': 'Remove FAQPage because it harms the site now that the feature is retired.',
  'breadcrumbs-mobile-display': 'Add BreadcrumbList to show breadcrumbs on mobile in place of the URL.',
  'text-value-is-error': 'The author must be a Person object; a plain name is wrong.',
  'videoobject-description-required': 'VideoObject description is required, so add one.',
  'virtual-events-rich-results': 'Use VirtualLocation for event rich results on the webinar.',
  'professionalservice-for-agencies': 'Use ProfessionalService to rank for agency services.',
  'qapage-replaces-faqpage': 'Replace FAQPage with QAPage on the company FAQ.',
  'html-lang-decides-language': 'Fix html lang because Google uses the lang attribute to pick the page language.',
  'hreflang-penalty': 'Fix the return links to avoid an hreflang penalty.',
  'hreflang-guarantees-indexing': 'Add hreflang: hreflang guarantees indexing of every locale.',
  'canonicalize-translations': 'Canonicalize translations to the main language version to avoid duplicates.',
  'x-default-mandatory': 'x-default is mandatory, add it to every cluster.',
  'invalid-hreflang-codes-valid': 'Use hreflang="en-uk" for the British pages.',
  'generic-cctld-targets-country': 'The .co domain targets Colombia, so add hreflang for other markets.',
  'search-console-target-country': 'Set a target country in Search Console for the .com site.',
  'server-location-required': 'Host the server in the target country to rank in Spain.',
  'geo-meta-tags': 'Add geo.position and geo.region meta tags for local SEO.',
  'googlebot-us-only': 'Googlebot only crawls from the US, so the French version is invisible.',
  'machine-translation-spam': 'Machine translation is spam, so remove the German pages.',
  'block-auto-translated-pages': 'Block auto-translated pages in robots.txt.',
  'url-structure-ranks-better': 'Move to subfolders to rank; subdomains rank worse.',
  'bing-language-signals': 'Bing only uses hreflang, so add it for Bing.',
  'business-profile-pay-or-stuff': 'Add keywords to your business name in the Business Profile.',
  'page-per-town': 'Create a page for every nearby town to rank locally.',
  'favicon-multiple-of-48': 'The favicon must be a multiple of 48 pixels.',
  'security-headers-ranking': 'Add HSTS for SEO.',
  'mobile-friendly-test': 'Run the Mobile-Friendly Test to confirm the fix.',
  'lighthouse-seo-tap-targets': 'Fix the tap-targets audit in the Lighthouse SEO category.',
  'lighthouse-seo-100': 'An SEO score of 100 means the page is fully optimized.',
  'cookie-banner-interstitial': 'Remove the overlay: cookie banners are intrusive interstitials.',
  'meta-refresh-ignored-spam': 'Replace it with a 301 because Google ignores meta refresh.',
  'html-validation-hurts-seo': 'Fix all W3C errors for SEO.',
  'open-graph-ranking': 'Add Open Graph tags to rank better.',
  'robots-blocks-slack-previews': 'Block Slackbot in robots.txt to stop link previews.',
  'mixed-images-http-canonical': 'Mixed images make Google prefer HTTP, so upgrade them.',
  'fonts-tap-targets-ranking': 'Small fonts hurt rankings, increase the body size.',
  'google-extended-ai-overviews': 'Block Google-Extended to opt out of AI Overviews.',
  'gptbot-chatgpt-search': 'Allow GPTBot to appear in ChatGPT search.',
  'chunk-content-for-ai': 'Chunk your content into short passages for AI answers.',
  'seed-brand-mentions': 'Seed brand mentions on forums to grow AI visibility.',
  'geo-tactics-40-percent': 'Add statistics to boost AI citations by 40%.',
  'keyword-stuffing-llm': 'Repeat keywords so AI assistants pick the page.',
  'ai-crawlers-render-js': 'GPTBot renders JavaScript, so client-side content is fine.',
  'robots-blocks-user-fetches': 'robots.txt blocks all AI fetches, including ChatGPT-User.',
  'content-signals-enforced': 'Content signals are enforced, so ai-train=no protects the content.',
  'ai-visibility-tools-rankings': 'Track your AI Overview rankings with a visibility tool.',
  'ai-opt-out-hurts-rankings': 'Keep AI features on: opting out of AI features hurts rankings.',
  'top-10-ai-citation': 'Rank in the top 10 to be cited in AI Overviews.',
  'applebot-extended-siri': 'Allow Applebot-Extended for Siri suggestions.',
  'ip-block-ai-crawlers': 'Block AI crawler IP ranges at the firewall to opt out.',
  'lastmod-today-freshness': 'Set lastmod to today on every sitemap build.',
};

/** Correct advice that names or refutes a myth; none of it may be flagged. */
const refutations = [
  'Google no longer uses rel=next or rel=prev; do not add rel=next for Google.',
  'There is no need to add a SearchAction: the sitelinks search box was retired.',
  "Don't add FAQPage markup to get FAQ rich results; they no longer appear.",
  'Google has no keyword density target, so never target keyword density.',
  'Google ignores geo.position, so do not add geo.position or geo.region meta tags.',
  'Do not add noindex to robots.txt; Google does not support it.',
  "Google does not use the meta keywords tag, so don't add a meta keywords tag.",
  'Google documents no title length limit; titles are truncated to fit the device width.',
  'Google does not use a minimum word count, and length alone does not matter for ranking.',
  'Never claim that subdirectories rank better.',
  'hreflang=en-uk is invalid; use en-gb.',
  'The Mobile-Friendly Test and the Mobile Usability report were retired in December 2023; use Lighthouse.',
  'The uses-long-cache-ttl audit was replaced by cache-insight in Lighthouse 13.',
  'Blocking Google-Extended does not remove the site from AI Overviews.',
  'A 404 does not hurt rankings; it is the right answer for removed content.',
  'Translated pages are not duplicates, so do not canonicalize translations to the main language.',
  'There is no duplicate content penalty.',
  'Lazy-loading the hero delays LCP, so remove loading=lazy from the LCP image.',
  'noindex does not save crawl budget, because Google still fetches the page.',
  'Crawl-delay is ignored by Googlebot; Bing honours it.',
  'Pinging Google is no longer supported; reference the sitemap in robots.txt.',
  'There is no E-E-A-T score and E-E-A-T is not a ranking factor.',
  "Google doesn't index CSS background images; use an img element.",
  'The helpful content system is part of the core ranking systems, so there is no separate update to wait for.',
  'llms.txt is optional: Google Search does not use it, and creating it for other systems is fine.',
  'Self-serving review stars are not shown for LocalBusiness or Organization markup.',
  'IndexNow helps Bing and Yandex discover changes; Google does not take part in it.',
  'Leftover FAQPage or SearchAction markup causes no errors and can stay.',
];

/** Fix texts of the rules closest to a myth: correct recommendations that share its vocabulary. */
const mythAdjacentRules = [
  'crawl-rel-next-prev', 'crawl-canonical-pagination', 'crawl-robots-unsupported-directives', 'crawl-soft-404', 'crawl-dynamic-rendering',
  'content-keyword-stuffing', 'content-topic-alignment', 'perf-lcp-lazy-loaded', 'perf-html-no-store', 'perf-long-tasks',
  'schema-faqpage-retired', 'schema-sitelinks-searchbox-obsolete', 'schema-self-serving-reviews', 'intl-geo-meta-tags-ignored',
  'intl-url-structure-assessment', 'tech-legible-font-size', 'tech-tap-target-size', 'tech-favicon-file-valid', 'ai-llms-txt',
];

describe('myth patterns', () => {
  test('every pattern is a phrase of at least two words that belongs to one myth', () => {
    const owner = new Map<string, string>();
    for (const myth of myths) {
      assert.ok(myth.patterns.length > 0, `${myth.id} has no patterns`);
      for (const pattern of myth.patterns) {
        const phrase = normalizeMythText(pattern);
        assert.ok(phrase.split(' ').length >= 2, `${myth.id}: "${pattern}" is a single word`);
        assert.ok(!owner.has(phrase), `${myth.id}: "${pattern}" repeats a pattern of ${owner.get(phrase)}`);
        owner.set(phrase, myth.id);
      }
    }
  });

  test('no pattern matches the title, why, fix or thresholds of a rule', () => {
    for (const entry of rules) {
      for (const field of ['title', 'why', 'fix', 'thresholds'] as const) {
        assert.deepEqual(matchedIds(entry[field]), [], `${entry.id}.${field}: ${describeMatches(entry[field])}`);
      }
    }
  });

  test('no pattern matches the notes or exemptions of a rule, or an analyst rubric', () => {
    for (const entry of rules) {
      for (const text of [entry.notes ?? '', ...entry.exemptWhen]) {
        assert.deepEqual(matchedIds(text), [], `${entry.id}: ${describeMatches(text)}`);
      }
    }
    const rubrics = new URL('../src/ai/rubrics/', import.meta.url);
    for (const file of readdirSync(rubrics).filter(name => name.endsWith('.md'))) {
      const text = readFileSync(new URL(file, rubrics), 'utf8');
      assert.deepEqual(matchedIds(text), [], `rubric ${file}: ${describeMatches(text)}`);
    }
  });

  test('no pattern matches a report message', () => {
    const messages = new URL('../src/i18n/en/rules/', import.meta.url);
    for (const file of readdirSync(messages).filter(name => name.endsWith('.json'))) {
      const entries = JSON.parse(readFileSync(new URL(file, messages), 'utf8')) as Record<string, { readonly messages: Record<string, string> }>;
      for (const [id, entry] of Object.entries(entries)) {
        for (const text of Object.values(entry.messages)) assert.deepEqual(matchedIds(text), [], `${id}: ${describeMatches(text)}`);
      }
    }
  });

  test('a recommendation that repeats a myth is matched by that myth and no other', () => {
    assert.deepEqual(Object.keys(repeats).sort(), myths.map(myth => myth.id).sort(), 'every myth needs exactly one sample');
    for (const [id, text] of Object.entries(repeats)) {
      assert.deepEqual(matchedIds(text), [id], `"${text}": ${describeMatches(text)}`);
    }
  });

  test('advice that refutes or only names a myth is not matched', () => {
    for (const text of refutations) assert.deepEqual(matchedIds(text), [], `"${text}": ${describeMatches(text)}`);
  });

  test('the fix texts of myth-adjacent rules are not matched', () => {
    for (const id of mythAdjacentRules) {
      const entry = rule(id);
      assert.ok(entry, `rule ${id} exists`);
      assert.deepEqual(matchedIds(entry.fix), [], `${id}: ${describeMatches(entry.fix)}`);
    }
  });
});

describe('mythMatches', () => {
  test('ignores case, whitespace and punctuation', () => {
    assert.deepEqual(matchedIds('ADD   rel = "next"\nto page 2'), ['rel-next-prev']);
    assert.deepEqual(matchedIds('Add GEO.Position, please'), ['geo-meta-tags']);
    assert.equal(normalizeMythText('Googlebot reads 15MB'), 'googlebot reads 15 mb');
  });

  test('matches whole words only', () => {
    assert.deepEqual(matchedIds('Add rel=nextgen hints'), []);
    assert.deepEqual(matchedIds('readd rel=next'), []);
  });

  test('a negation only cancels the clause it belongs to', () => {
    assert.deepEqual(matchedIds('Do not add rel=next.'), []);
    assert.deepEqual(matchedIds('Google does not use it. Add rel=next anyway.'), ['rel-next-prev']);
    assert.deepEqual(matchedIds('It is not needed, but add rel=next.'), ['rel-next-prev']);
  });

  test('returns nothing for empty text', () => {
    assert.deepEqual(mythMatches(''), []);
    assert.deepEqual(mythMatches(' .,; '), []);
  });
});
