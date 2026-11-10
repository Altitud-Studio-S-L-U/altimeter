# Owner data and AI answer probes

[Back to the project overview](../README.md). Commands run from the repository root unless stated otherwise.

## Owner data

Altimeter reads data that only the site's owner can authorise, read-only, from credentials you provide. It never looks for tokens of other tools.

- **Search Console.** `altimeter gsc login --client client_secret.json --remember dpapi` signs in with your own OAuth client and the `webmasters.readonly` scope and stores the login for later audits, protected with Windows DPAPI (`--remember file` keeps it in a file only you can read instead); `ALTIMETER_GSC_ACCESS_TOKEN` or a service account key in `ALTIMETER_GSC_SA_KEY` also work. `audit --gsc` then adds URL Inspection results (index state, the canonical Google chose, the last crawl, rich result issues), sitemap reports and performance analyses such as pages whose click-through rate is far below the site's own norm. Queries stay on your machine unless you run `ai-probe --from-gsc`, which asks the engines your top non-brand queries; in an audit, `--redact-queries` writes numbered labels instead of them, for a report you want to share. These findings never change the score.
- **Bing Webmaster Tools.** Set `BING_WEBMASTER_API_KEY` to a key from Bing Webmaster Tools (Settings > API Access); `audit --bing` adds the crawl issues Bing lists, page and query traffic, and what Bing knows about the audited pages. The API takes the key in the query string, so Altimeter never logs request URLs and removes the key from every error; `--redact-queries` covers Bing's queries too. Citations in Copilot appear only in Bing's AI Performance report, which has no API; the report points to it.
- **Crawler activity.** `altimeter bots --cloudflare-zone example.com` or `--logs <file>` (and `audit --bots-from cloudflare` or `--bots-from <file>`) reads the requests the site really received, verifies each crawler against its operator's published IP list or reverse DNS, and reports AI crawlers that robots.txt allows but the server or CDN refuses, crawlers that ignore robots.txt, sitemap URLs Googlebot never fetched, spoofed crawlers and visits referred by AI assistants. Logs never leave your machine; the Cloudflare token, read-only, goes in `ALTIMETER_CLOUDFLARE_API_TOKEN`. See [crawler activity](../docs/crawler-activity.md).
- **Field data.** Set `ALTIMETER_GOOGLE_API_KEY` to a Google Cloud API key with the Chrome UX Report API enabled; the key travels in a request header to Google only.

## AI answer probe

```sh
altimeter ai-probe example.com --keyword "garden tools andorra"          # print the plan, call nothing
altimeter ai-probe example.com --keyword "garden tools andorra" --yes    # run it
```

The probe asks a few questions, several times each, through your own Claude Code and Codex sign-ins with web search, and counts how often the answers cite the site, which of its pages they cite and which other domains they cite instead. For Claude Code a citation counts only when its own search returned that page. It is a sample from these CLI agents, not rank tracking: it does not represent ChatGPT, Claude.ai, Copilot, Perplexity or Google AI Overviews, it reports counts and no score, and every call counts toward your plan. See [AI answer probe](../docs/ai-probe.md).

## Collected evidence

Altimeter collects the facts that search engines act on and checks them against a catalog of rules in which every rule cites a primary source, such as Google Search Central, web.dev, Bing Webmaster Guidelines, schema.org or an RFC, with the date that source was last verified. Claims that current guidance contradicts, such as keyword density, a minimum word count or fixed title lengths, are documented as myths and never reported.

What it collects for an audited page:

- the HTTP response and every redirect hop, robots.txt (RFC 9309) and the sitemaps;
- the raw HTML and a render in Chrome that behaves like Googlebot (a phone-width viewport that grows to the page height, no scrolling, subresources blocked by robots.txt left out), plus a scrolled render and an unblocked render for diagnosis;
- structured data (JSON-LD, microdata and RDFa) checked against a schema.org vocabulary snapshot;
- URL variants (trailing slash, `/index.html`, case, tracking parameters, `http`, `www`), an unknown URL, the hreflang alternates and the page fetched with the user agents of search and AI crawlers;
- Lighthouse lab data (median of several runs) and Chrome UX Report field data when you provide a key;
- with your authorisation, Google Search Console and Bing Webmaster Tools data, and the crawler requests your access logs or Cloudflare analytics recorded, each crawler verified the way its operator documents.

An optional analysis step asks the Claude Code or Codex CLI you already use to judge what code cannot, such as whether content answers the query or whether structured data matches the visible page. Every claim must cite collected evidence and quote it word for word, passes validation in code and is checked again by a verifier; claims that fail are dropped with their reason.

Each failed check is also a task for a coding agent, with the files that most likely hold the fix and acceptance checks that `altimeter verify` re-runs against a local build.
