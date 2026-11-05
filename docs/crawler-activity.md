# Crawler activity

A robots.txt file says what crawlers may fetch; only the site's own records say what they did fetch. `altimeter bots`
reads those records, verifies each crawler's identity the way its operator documents, and compares the requests with
the site's robots.txt and sitemaps. `altimeter audit --bots-from` adds the same data to an audit.

```sh
altimeter bots --cloudflare-zone example.com                       # Cloudflare analytics of the last 30 days
altimeter bots --logs /var/log/nginx/ --site https://example.com/  # every file in the folder, plain or gzip
altimeter audit https://example.com/ --bots-from cloudflare
altimeter audit https://example.com/ --bots-from access.log --bots-from access.log.1.gz --bots-days 14
```

The command writes `bots.json` and `bots.md` to `altimeter-report/<host>/<time>-bots/`. In an audit the crawler
rules become findings of the report. Like all owner data, they never change the score.

## Sources

- **Access logs.** Supported formats are Apache and nginx combined and common, nginx JSON (or any JSON lines with
  `--json-fields`), IIS W3C, CloudFront, Application Load Balancer, Cloudflare Logpush, and Vercel and Netlify log
  drains. Files can be plain or gzip, and a folder stands for the files in it; files in a folder that are empty or in
  no recognised format, such as an error log, are skipped with a warning, while a file named on its own must be an
  access log. The format is detected from the first lines unless `--log-format` names it. Files are read as streams,
  twice (once to collect the addresses to check, once to count), so memory stays bounded whatever their size.
- **Cloudflare GraphQL Analytics.** Reads the `httpRequestsAdaptiveGroups` dataset with a read-only API token you
  create, passed in `ALTIMETER_CLOUDFLARE_API_TOKEN`. The token needs Zone > Analytics > Read, plus Zone > Zone > Read
  so the zone can be found by name; a 32-character zone ID works without the second permission. Altimeter first reads
  the zone's limits and available fields and plans its queries around them. Cloudflare samples this dataset, so every
  count is an estimate and the report marks it with `~`. The window starts no earlier than the data the zone keeps,
  and a query that returns its maximum rows makes the counts lower bounds; the report says so in both cases.
- **The client address.** Server logs use the address the server recorded (`remote`). Behind one trusted proxy or load
  balancer, `--ip-source xff-last` takes the last `X-Forwarded-For` entry. `xff-first` takes the first entry, which any
  client can forge, so use it only when every hop is trusted. A log in which at least 95% of 200 or more requests come
  from one or two addresses records a proxy, not clients: its addresses are not used to verify crawlers, and the
  report explains why. The same applies to addresses in Cloudflare's published ranges.

## Verification

Every request whose user agent names a known crawler is a claim:

- **verified** when it passes a check the operator documents: its published IP list, or a reverse DNS name under the
  operator's domain confirmed by a forward lookup (for Google, Bing, Apple and Common Crawl). In Cloudflare's data, a
  request Cloudflare itself assigned a verified bot category is verified too;
- **spoofed** when every documented check could run and all of them failed;
- **unverified** when a check could not run: no client address (in Cloudflare's data, no address and no verified bot
  category), a proxy address, a list that could not be read, or DNS turned off or failing.

Operators that document no check (Meta's crawlers, ByteDance's Bytespider and MistralAI-Training) are unverifiable.
Their requests stay claims and are never reported as zero verified visits. Anthropic publishes one list for all its
crawlers, which proves the request came from Anthropic but not from which crawler. Google-Extended and
Applebot-Extended exist only as robots.txt tokens: no request carries them, so they are listed as not observable.

An operator's IP list is downloaded from its published URL only when a claimed request with an address could be
checked against it. Lists are cached for a day in the user cache folder (`altimeter/bot-ip-ranges`). A failed download
falls back to the cached copy, and the report gives its age. Reverse DNS uses the system resolver for up to 400
distinct addresses per run, the busiest first; `--no-dns` (or `--no-bots-dns` in an audit) turns it off, and the
crawlers that need it stay unverified.

## What is measured

For each crawler, with its purpose (search, training or a fetch a user asked for):

- verified, unverified and spoofed requests, the first and last request and the active days;
- response codes, so a 403 from a firewall, a 402 from pay-per-crawl or a 429 shows up for the crawler that got it;
- fetches of robots.txt and `llms.txt`, and of scripts and style sheets, a hint that the crawler renders pages;
- the most requested paths and how many sitemap URLs the crawler fetched;
- verified requests for paths the current robots.txt disallows, counted from the moment the crawler must have known
  the file: the end of its robots.txt caching window (the hours its operator documents, or the 24 hours of RFC 9309)
  or its first fetch of robots.txt, whichever comes first. The clock starts when the current file took effect, taken
  from `--robots-since`, the file's `Last-Modified` header or, failing both, the start of the data, which the report
  flags as an assumption. Fetches a user asked for are not crawls and are not counted.

When the source records referrers, the report also counts visits referred by AI assistants: chatgpt.com (and links
tagged `utm_source=chatgpt.com`), perplexity.ai, copilot.microsoft.com, gemini.google.com and claude.ai. Visits from
AI Overviews and AI Mode arrive as Google search and cannot be told apart.

## Rules

| Rule | What it reports |
| --- | --- |
| `ai-bots-crawl-activity` | Which AI crawlers really fetched the site, verified, with the claims that could not be verified. |
| `ai-bots-blocked-at-edge` | AI search and user-triggered crawlers that robots.txt allows but the server or CDN refused. |
| `ai-bots-search-not-seen` | AI search crawlers that robots.txt allows but that never appeared in the window. |
| `ai-bots-referrals` | Visits referred by AI assistants. |
| `crawl-bots-blocked-at-edge` | Search engine crawlers refused by the server or CDN. |
| `crawl-bots-robots-compliance` | Verified crawlers that fetched paths robots.txt disallows them. |
| `crawl-bots-googlebot-sitemap-coverage` | Sitemap URLs verified Googlebot did not fetch in the window. |
| `crawl-bots-spoofed-crawlers` | Requests that used a crawler's user agent from addresses its operator does not use. |

Each rule's thresholds and sources are in the [rule catalog](rules.md). Sitemap URLs come from the sitemaps an audit
reads, with the same limits (see [methodology](methodology.md#1-collect)); `altimeter bots` reads only those robots.txt
declares, or `/sitemap.xml` when it declares none.

## Privacy

Logs are read on your machine and never uploaded. Paths and user agents in the output are cleaned of control and
invisible characters and treated as untrusted text. Reverse DNS sends the addresses of claimed crawler requests to
your DNS resolver; `--no-dns` avoids it. The Cloudflare token is sent only to Cloudflare's API and never appears in
reports, logs or error messages. Crawler activity never reaches a model.
