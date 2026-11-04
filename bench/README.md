# Integrated benchmark

`npm run bench` audits 27 synthetic sites end to end, over HTTPS and with Chrome, and checks each audit against what the scenario declares. It prints true and false positives and negatives per rule with precision and recall, then every expectation that did not hold. It exits 0 when every expectation holds, 1 when one does not, and 2 when Chrome is missing or an argument is wrong.

```sh
npm run bench
npm run bench -- --scenario studio-home --scenario locale-redirects
npm run bench -- --repeat 3     # also fail when a scenario's deterministic findings change between runs
npm run bench -- --findings     # also list every failing finding, to help write expectations
```

It needs Chrome or Chromium (found as the CLI finds it, or through `CHROME_PATH`) and takes about three to four minutes on a laptop.

## How it works

- **One port, both protocols.** Each scenario gets a fresh loopback port that answers plain HTTP and HTTPS: the first byte of a connection decides, since 0x16 opens a TLS handshake. URL variants, `http://` upgrades and `www` counterparts therefore keep the same explicit port, as the collector builds them. The `Host` header picks the site and SNI picks the certificate.
- **Nothing leaves the machine.** The scenario's host names resolve to 127.0.0.1 through the `lookup` option that `audit()` passes to the HTTP client, the TLS probe and Chrome's guarded proxy. Every other name fails to resolve, and the network policy admits private addresses only for those names. The sites use the reserved `.example` domain because Altimeter treats `*.test` hosts as staging hosts and skips several rules for them.
- **Real certificates, generated per run.** `test/support/certificates.ts` creates a CA in memory and a leaf for each scenario's hosts; servers send the leaf with the CA. The audit receives the CA through its `ca` option: the HTTP client and the TLS probe trust it besides the default roots, and Chrome accepts the chain through `--ignore-certificate-errors-spki-list`. No key is written to disk.
- **The real pipeline.** Every scenario runs through `audit()` with Chrome rendering, no model provider and crawls without a delay. Lighthouse runs, once, only in the two scenarios that need it.

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

## The traps

Each false-positive trap of the tuned site appears in its correct form, where the related rules must not fail, and where a rule covers it, in a form with the real problem, where they must fail.

| Trap | Correct twin | Problem twin |
| --- | --- | --- |
| Root answers 302 to a locale, private and no-store | `studio-root` | `locale-redirects`, `locale-unreachable` |
| Accept-Language ignored on purpose | `studio-home`, `studio-root` | `locale-redirects`, `locale-adaptive` |
| `Vary: Cookie` on a private, no-store redirect | `studio-root` | `locale-redirects` (cacheable without Vary) |
| `/sitemap.xml` answers 404; the index is declared | `studio-home` | `sitemap-missing` |
| Valid FAQPage that matches the page | `studio-home` (information only) | `faq-not-visible` (known gap), `markup-mismatch` |
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

Known gaps, listed by every run:

- `tech-security-headers-info` (`studio-home`): the inventory shows the CSP, but its thresholds flag only a broken `nosniff` value, not `script-src 'unsafe-inline'`.
- `schema-visible-content-parity` (`faq-not-visible`): by its thresholds it compares only prices and ratings with the page text, so FAQ answers missing from the page are left to the model analysis.

## Adding a scenario

1. Create `bench/scenarios/<name>.ts` that exports `defineScenario({...})`. Most scenarios start from the studio: `studioSite(context, path, options, site => { ... })` edits its pages, headers, structured data, routes or robots.txt before the server starts.
2. Add it to `bench/scenarios/index.ts`.
3. Run `npm run bench -- --scenario <name> --findings` and declare what the scenario introduces in `mustFail` and the traps it must not trip in `mustNotFail`.
4. When a rule disagrees, read its catalog entry: fix the rule with a unit test when it contradicts its own thresholds, or mark the expectation `known` with a one-line reason when it is a judgment call. Never weaken or delete an expectation to make the run pass.
