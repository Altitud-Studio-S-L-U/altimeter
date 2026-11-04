# Integrated benchmark

`npm run bench` audits 46 synthetic sites end to end, over HTTPS and with Chrome, and checks each audit against what the scenario declares. It prints true and false positives and negatives per rule with precision and recall, then every expectation that did not hold. It exits 0 when every expectation holds, 1 when one does not, and 2 when Chrome is missing or an argument is wrong.

```sh
npm run bench
npm run bench -- --scenario studio-home --scenario locale-redirects
npm run bench -- --repeat 3     # also fail when a scenario's deterministic findings change between runs
npm run bench -- --findings     # also list every failing finding, to help write expectations
```

It needs Chrome or Chromium (found as the CLI finds it, or through `CHROME_PATH`) and takes about seven to eight minutes on a laptop, half of them for the [hold-out set](#the-hold-out-set).

## How it works

- **One port, both protocols.** Each scenario gets a fresh loopback port that answers plain HTTP and HTTPS: the first byte of a connection decides, since 0x16 opens a TLS handshake. URL variants, `http://` upgrades and `www` counterparts therefore keep the same explicit port, as the collector builds them. The `Host` header picks the site and SNI picks the certificate.
- **Nothing leaves the machine.** The scenario's host names resolve to 127.0.0.1 through the `lookup` option that `audit()` passes to the HTTP client, the TLS probe and Chrome's guarded proxy. Every other name fails to resolve, and the network policy admits private addresses only for those names. The sites use the reserved `.example` domain because Altimeter treats `*.test` hosts as staging hosts and skips several rules for them.
- **Real certificates, generated per run.** `test/support/certificates.ts` creates a CA in memory and a leaf for each scenario's hosts; servers send the leaf with the CA. The audit receives the CA through its `ca` option: the HTTP client and the TLS probe trust it besides the default roots, and Chrome accepts the chain through `--ignore-certificate-errors-spki-list`. No key is written to disk.
- **The real pipeline.** Every scenario runs through `audit()` with Chrome rendering, no model provider and crawls without a delay. Lighthouse runs, once, only in the three scenarios that need it.

## Expectations and the scores

A scenario declares two lists:

- `mustFail`: rules that must report a failure, optionally with a severity, a reason and the page. A matching failure is a true positive; none is a false negative.
- `mustNotFail`: rules that must pass or not apply on the page or site (or reach the outcome given, such as `not_evaluated`). A failure is a false positive; otherwise it is a true negative. When the rule reached neither outcome the check proves nothing and fails as "not evaluated".

Precision is TP / (TP + FP) and recall TP / (TP + FN). An expectation marked `known: '<reason>'` is a documented gap: it is counted and listed but does not fail the run, and the runner says when it no longer reproduces. A rule that throws, a collector warning or a request for a host the scenario does not serve also fails the run.

## Scenarios

The shared site is an invented engineering studio in English and Spanish (`bench/support/studio.ts` and `studio-content.ts`). It has the structure of the small multilingual site the rules are tuned on, with none of its text: a root that redirects to a locale, hreflang and a sitemap index, JSON-LD with Organization, WebSite, FAQPage and BreadcrumbList, a cookie banner, scroll-reveal sections and security headers behind a CDN.

| Scenario | What it covers |
| --- | --- |
| `studio-home` | The English home as the tuned site serves it: every trap in its correct form, and the expected findings (temporary trailing-slash and `index.html` redirects, no `lastmod`, Organization without `sameAs`, FAQPage as information, the CDN). |
| `studio-root` | The bare root: a 302 locale entry point that is private, no-store and `Vary: Cookie`, ignores Accept-Language, with x-default on `/en/`. |
| `studio-service` | A service page: breadcrumb names that repeat the SEO title with the brand suffix, a Service node, an eager hero image. |
| `studio-es` | The Spanish home: language signals, hreflang and translated metadata. |
| `studio-crawl` | A crawl: noindex, follow legal pages in the footer and out of the sitemap, a short About page, one shared Open Graph image. |
| `studio-polished` | The expected findings fixed: 301 redirects, `lastmod`, `sameAs`, short breadcrumb names, a CSP with a script hash. |
| `studio-lab` | The service page under Lighthouse: an eager hero image with a priority hint and sized lazy images below it. |
| `locale-redirects` | A cacheable 301 root chosen by Accept-Language without `Vary`, and `/en/` sending Spanish speakers to `/es/`. |
| `locale-unreachable` | Spanish URLs that send every visitor without the language cookie, crawlers included, to `/en/`. |
| `locale-adaptive` | The root answering 200 in Spanish or English depending on Accept-Language. |
| `sitemap-missing` | No sitemap in robots.txt or the HTML, and nothing at `/sitemap.xml`. |
| `markup-mismatch` | A marked-up price the page never shows, and the retired SearchAction. |
| `faq-not-visible` | FAQPage markup for questions the page no longer shows. |
| `image-problems` | Content images without an `alt` attribute, a file name as alt text and a loader that waits for a scroll event. |
| `lcp-lazy` | The LCP hero image loaded lazily and without a priority hint (Lighthouse). |
| `legal-in-sitemap` | Noindex legal pages listed in the sitemap, and an About page left noindex. |
| `consent-problems` | A Google tag configured before any consent default, and a cookie wall that empties the page. |
| `page-structure` | A newsletter modal over the first screen, skipped heading levels and an h1 that is an image without alt. |
| `hidden-text` | Keyword text in the background colour and off screen. |
| `js-only-content` | A service page whose heading and text exist only after a script runs. |
| `delivery-problems` | The charset declared after the first 1024 bytes, HTML marked no-store and sent uncompressed. |
| `thin-service` | A service page with a two-line stub inside the template (crawl). |
| `media-problems` | An Organization logo that answers 404 and an og:image smaller than its declared size. |
| `ai-crawlers-blocked` | A wildcard group that blocks every AI search crawler while Googlebot and Bingbot keep their own groups. |
| `header-conflicts` | A Spanish `Content-Language` on an English page, a `Link` hreflang without the page and `X-Robots-Tag: noindex`. |
| `transport-problems` | An expired certificate on `www`, a 302 HTTP upgrade and no Strict-Transport-Security. |
| `crux-no-data` | A Chrome UX Report endpoint with no data for the page: information, not a failing Core Web Vital. |
| `holdout-ai-robots-named` | robots.txt groups that name the AI training crawlers, a legacy `Perplexity` token, AI search agents answered 403 and 402 at the edge, and a `dateModified` stamped per request. |
| `holdout-ai-robots-inherited` | A `*` group that disallows the site while Googlebot and Bingbot keep their own groups, the same edge answers, and prerendered HTML for Googlebot. |
| `holdout-robots-directives` | `noindex` and `crawl-delay` lines, a Googlebot group that drops the crawl-trap rules of `*`, a blocked analytics script and the Spanish services blocked for Googlebot. |
| `holdout-robots-redirected` | robots.txt redirected to the HTML home, a `<base href>` that sends relative links to 404, a canonical in the body, `noarchive` and `unavailable_after` ten days away. |
| `holdout-legacy-host` | robots.txt answering 503, an XHTML doctype, a 1024-pixel viewport without zoom, HSTS preload with a one-day max-age, framing limited by a meta CSP and a canonical to staging. |
| `holdout-noindex-blocked` | A noindex legal notice that robots.txt disallows, with `indexifembedded`, `noarchive`, an older year in its title and no description; well-formed business identifiers. |
| `holdout-head-pixel` | A tracking pixel in the head before the canonical and hreflang, 10px text, a 900px table, zoom capped at 3x, an icon-only link and one anchor repeated ten times. |
| `holdout-head-js` | A script that sets the title, changes the canonical and adds hreflang and a BreadcrumbList, with the stylesheet blocked for Googlebot, geo meta tags, an `unload` listener and a font preload without `crossorigin`. |
| `holdout-noindex-js` | A noindex that JavaScript removes, which also adds the only canonical, prefixes an unread counter to the title and marks a block `data-nosnippet`; a noscript pixel. |
| `holdout-canonical-conflict` | Two canonicals, an hreflang link with a media query, a delayed meta refresh, a past `unavailable_after` with `indexifembedded`, `notranslate` and only nofollow citations. |
| `holdout-hreflang-invalid` | `fil`, `es-419`, `pt_BR`, a root-relative href, `de` and `DE` on two URLs, one URL for two languages and a canonical with a fragment. |
| `holdout-hreflang-regional` | `EN`, `en-GB` and `en-US` on one URL, `es`, x-default and a page for US clients declared as `us`. |
| `holdout-hreflang-cross-language` | A Spanish page canonicalised to the English one, in a cluster of `en-GB`, `es-ES` and a Catalan page declared as `ca`, without x-default. |
| `holdout-mixed-content` | A script and an image over http without `upgrade-insecure-requests`, http links, canonical and hreflang, a combined preconnect and an iframe without a title. |
| `holdout-mixed-upgraded` | The same requests behind `upgrade-insecure-requests`, a relative canonical, a scrolling carousel, speculation rules, a titled iframe and a form declared as a WebMCP tool. |
| `holdout-template-leftovers` | An empty title beside an SVG title, an empty description, an assistant phrase, template tokens and a JSON-LD block without `@context`, hidden notes for AI assistants and a 300-row table. |
| `holdout-blog` | A crawled blog: posts with and without bylines, images, matching dates and qualified links, a stale year in a title, a canonical loop, page 2 canonicalised to page 1, hash routes and a post that answers 500. |
| `holdout-shop` | A crawled shop: a free product with an out-of-range rating, a bad GTIN and shipping in another currency beside its correct twin, events, an expired job and a LocalBusiness. |
| `holdout-lab-field` | The service page under Lighthouse with field data: a 1.5-second script at load, an unnamed button, unused unminified JavaScript and a stylesheet cached for an hour. |

## The traps

Each false-positive trap of the tuned site appears in its correct form, where the related rules must not fail, and where a rule covers it, in a form with the real problem, where they must fail.

| Trap | Correct twin | Problem twin |
| --- | --- | --- |
| Root answers 302 to a locale, private and no-store | `studio-root` | `locale-redirects`, `locale-unreachable` |
| Accept-Language ignored on purpose | `studio-home`, `studio-root` | `locale-redirects`, `locale-adaptive` |
| `Vary: Cookie` on a private, no-store redirect | `studio-root` | `locale-redirects` (cacheable without Vary) |
| `/sitemap.xml` answers 404; the index is declared | `studio-home` | `sitemap-missing` |
| Valid FAQPage that matches the page | `studio-home` (information only) | `faq-not-visible`, `markup-mismatch` |
| WebSite without SearchAction | `studio-home` | `markup-mismatch` |
| `alt=""` on decorative images | `studio-home` | `image-problems` |
| Noindex, follow legal pages out of the sitemap | `studio-crawl` | `legal-in-sitemap` |
| Analytics injected only after consent | `studio-home` | `consent-problems` |
| Cookie banner headings outside `<main>` | `studio-home` | `page-structure`, `consent-problems` |
| Scroll-reveal sections at opacity 0 until scrolled | `studio-home`, `studio-es` | `hidden-text`, `js-only-content` |
| `text/html` without charset, `<meta charset>` first | `studio-home` | `delivery-problems` |
| `max-age=0, must-revalidate` with an ETag | `studio-home` | `delivery-problems` |
| A short About page | `studio-crawl` | `thin-service` |
| An SVG Organization logo | `studio-home` | `media-problems` |
| robots.txt without AI groups, an informational llms.txt | `studio-home` | `ai-crawlers-blocked` |
| No `X-Robots-Tag`, `Content-Language` or `Link` header | `studio-home` | `header-conflicts` |
| One h1 that joins a keyword line and a tagline | `studio-home` | `page-structure` |
| One Open Graph image shared by several pages | `studio-crawl` | `media-problems` |
| The same lazy images twice on the home | `studio-home`, `studio-crawl`, `studio-lab` | `image-problems`, `lcp-lazy` |
| The brand query observed on a non-Google engine | not applicable | not applicable |

Not applicable, and why:

- **The brand query on another search engine.** No rule reads search results: a claim about Google's index needs Search Console or Google data, which the benchmark does not fake.
- **No `twitter:site`.** `tech-social-twitter-card` is planned, and its catalog entry already says an absent `twitter:site` matters only when the owner has an account; no rule may report it.
- **The root is not the x-default.** The catalog says this is never a finding, so `studio-root` expects the root and x-default rules not to fail.
- **Decorative images that cannot rank in image search.** `alt=""` is never counted as missing; `studio-home` expects `content-img-alt-missing` not to fail.

There are no known gaps: every expectation must hold.

## The hold-out set

The `holdout-*` scenarios measure whether rules do what their catalog entries promise, rather than whether they fit fixtures written next to them. They check 128 rules that no other scenario checks, with 192 expectations: 132 failures to find and 60 correct forms, most of them the exemptions and edge cases that the entries name. Each expectation was derived from the rule's catalog entry alone (its thresholds, exemptions and notes), without reading the rule implementations or their tests, and the scenarios were committed before they were first run. `bench/support/holdout.ts` holds the few helpers they share.

`npm run bench` runs them after the other scenarios, in about four minutes. To run only some of them, name each one:

```sh
npm run bench -- --scenario holdout-blog --scenario holdout-shop --scenario holdout-lab-field
```

An expectation of the set that does not hold stays failing until it is triaged against the rule: a scenario that did not serve what it meant is fixed, and so is a rule that contradicts its catalog entry; an entry that is ambiguous for the case is clarified. An expectation is never weakened, deleted or marked `known` to make the run pass.

## Adding a scenario

1. Create `bench/scenarios/<name>.ts` that exports `defineScenario({...})`. Most scenarios start from the studio: `studioSite(context, path, options, site => { ... })` edits its pages, headers, structured data, routes or robots.txt before the server starts.
2. Add it to `bench/scenarios/index.ts`.
3. Run `npm run bench -- --scenario <name> --findings` and declare what the scenario introduces in `mustFail` and the traps it must not trip in `mustNotFail`.
4. When a rule disagrees, read its catalog entry: fix the rule with a unit test when it contradicts its own thresholds, or mark the expectation `known` with a one-line reason when it is a judgment call. Never weaken or delete an expectation to make the run pass.
