# How Altimeter audits a site

An audit has five stages: collect the facts, decide whether the page can be audited, evaluate the rule catalog,
optionally ask a model to judge what code cannot, and turn what failed into tasks. Every stage records what it could
not do, so the report says how much of the catalog it actually evaluated.

## 1. Collect

For the audited URL Altimeter gathers:

| Fact | How |
| --- | --- |
| Response and redirects | Each hop with its status, headers and timing; HTML is read up to 4 MB. |
| robots.txt | Fetched and parsed by RFC 9309, including how each crawler's group applies. |
| Sitemaps | The first 5 that robots.txt declares or the audited page and the home page link with `rel="sitemap"`, or `/sitemap.xml` when none is declared. Index files are followed to at most 10 child sitemaps in all, and each file is read up to the protocol's 50 MB. Rules that compare pages or owner data with sitemap URLs see only the URLs of these files, and the report warns when a limit left sitemaps unread. |
| URL variants | Trailing slash, `/index.html`, upper case, a tracking parameter, a double slash, `http` and the `www` or apex host, to see whether each consolidates. |
| Unknown URL | A random path, to see how the site answers a page that does not exist. |
| Home page and two linked pages | Context for site-wide rules and to tell template text from page content. |
| hreflang alternates | Up to ten alternates the page declares, so reciprocity can be checked without a crawl. |
| Crawler probes | The home page fetched as Googlebot, Bingbot and the search and answer crawlers of AI services, and the audited page as Googlebot and as a browser. A probe shows how the site answers that user agent; it cannot prove what the real crawler receives, because real crawlers are recognised by IP. |
| TLS | The certificate of the host and of its `www` or apex counterpart. |
| Language negotiation | The home page and the audited page requested with several `Accept-Language` values. |
| Referenced resources | Favicons, Open Graph images, logos and `/llms.txt`. |
| Renders | In Chrome: a Googlebot-like render (phone width, the viewport grows to the page height, no scrolling, subresources robots.txt blocks for Googlebot are not loaded), a scrolled render of the first screens like a person would see them, and a render without the robots.txt blocking when something was blocked. Renders record text visibility, fixed overlays at load, layout shifts, the largest contentful paint and failed requests. |
| Lab data | Lighthouse, the median of several runs (three by default). |
| Field data | Chrome UX Report data for the URL and the origin the page is served from after its redirects, phone and desktop, when a key is set. |
| Owner data | With your authorisation: Search Console URL Inspection, sitemap reports and performance data; Bing Webmaster Tools crawl issues, traffic and URL details; and the crawler requests in your access logs or Cloudflare analytics, each crawler verified against its operator's IP list or reverse DNS (see [crawler activity](crawler-activity.md)). The Search Console property and the Bing site are the ones that cover the page as it is served after its redirects, unless you name one. |

`--crawl` adds a polite breadth-first crawl from the page, the home page and the sitemaps: two requests in flight, a
pause between requests, robots.txt respected for Googlebot and a page limit (100 by default). Renders run on the
audited page and the home page, and Lighthouse on the audited page; the other pages are checked from their HTML.

## 2. Decide whether the page can be audited

A firewall challenge, a login wall or a response that never arrived is not the page. When the audited page is one of
these, every page rule reports "not evaluated" with the reason, and the audit exits with status 3 instead of scoring
a page Altimeter never saw.

## 3. Evaluate the rules

Each rule in the [catalog](rules.md) states what it reads, which page types it applies to, its maximum severity, its
thresholds, when it is exempt and the primary sources it rests on, each with the date it was last verified. A rule's
outcome is one of:

- **pass**: the check ran and found nothing wrong;
- **fail**: the check found a problem, with a severity no higher than the rule's maximum and the evidence it rests on;
- **not applicable**: the rule does not concern this page, for example a product rule on an article;
- **not evaluated**: an input was missing (no render, no field data, no crawl) or the rule could not decide.

Some rules are hybrid: code finds a candidate, such as text that might be hidden, and only judgment can confirm it.
Candidates are listed for review and count for nothing until the model analysis confirms them with a supported
verification. Rules that read owner data run only when you provide it.

Every finding cites evidence items: what was observed, where (URL, line, selector or JSON-LD path) and the exact
excerpt. Excerpts copied from the site are untrusted data everywhere they appear.

The catalog also lists myths: claims that current guidance contradicts, such as keyword density or a minimum word
count. Altimeter never reports them and drops model output that repeats them.

## 4. Model analysis (optional)

The analyst judges what code cannot: whether the content answers the page's purpose, whether structured data matches
the visible page, whether translations say the same thing. Each answer must cite evidence ids and quote them word for
word; code checks every claim and a second call verifies the survivors against only their evidence. See the model
analysis section of the [README](../README.md#model-analysis) and [SECURITY.md](../SECURITY.md#model-analysis).

## 5. Score and tasks

The score uses only deterministic checks marked as scored. For each category it is
100 × (1 − the weights of the failed severities / the weights of the maximum severities of every evaluated check),
with weights critical 10, high 5, medium 3 and low 1, and the overall score weights each category by its evaluated
weight. Info checks, model judgments, owner data and checks that could not be evaluated never change it. The report
shows coverage next to the score, and an indexability gate says whether any critical crawling or indexing check
failed.

Failed checks become tasks. A defect seen on several pages becomes one task with every page as its scope, because it
is usually one template fix. Each task says where the fix belongs (the site's code, the hosting configuration, the CDN,
the content, an external account or a decision for the owner), how it can be verified, which checks must pass once it
is done and which checks that pass today must keep passing. With `--source`, it also names the files of the site's
repository that most likely hold the fix.
