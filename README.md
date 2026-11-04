# Altimeter

Evidence-based SEO audits for websites, with model analysis that is checked against the evidence before it reaches the report.

[![CI](https://github.com/Altitud-Studio-S-L-U/altimeter/actions/workflows/ci.yml/badge.svg)](https://github.com/Altitud-Studio-S-L-U/altimeter/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Altitud-Studio-S-L-U/altimeter/actions/workflows/codeql.yml/badge.svg)](https://github.com/Altitud-Studio-S-L-U/altimeter/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Altitud-Studio-S-L-U/altimeter/badge)](https://scorecard.dev/viewer/?uri=github.com/Altitud-Studio-S-L-U/altimeter)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 24](https://img.shields.io/badge/Node.js-%E2%89%A524-43853d?logo=node.js&logoColor=white)](package.json)
[![Rules](https://img.shields.io/badge/rules-352%20with%20primary%20sources-2b4c7e)](docs/rules.md)
[![Security policy](https://img.shields.io/badge/security-policy-44546a)](SECURITY.md)

> **Status:** in development. Version 0.1.0 is not published yet; the commands below describe the interface as it is built.

Altimeter collects the facts that search engines act on and checks them against a catalog of rules in which every rule cites a primary source, such as Google Search Central, web.dev, Bing Webmaster Guidelines, schema.org or an RFC, with the date that source was last verified. Claims that current guidance contradicts, such as keyword density, a minimum word count or fixed title lengths, are documented as myths and never reported.

What it collects for an audited page:

- the HTTP response and every redirect hop, robots.txt (RFC 9309) and the sitemaps;
- the raw HTML and a render in Chrome that behaves like Googlebot (a phone-width viewport that grows to the page height, no scrolling, subresources blocked by robots.txt left out), plus a scrolled render and an unblocked render for diagnosis;
- structured data (JSON-LD, microdata and RDFa) checked against a schema.org vocabulary snapshot;
- URL variants (trailing slash, `/index.html`, case, tracking parameters, `http`, `www`), an unknown URL, the hreflang alternates and the page fetched with the user agents of search and AI crawlers;
- Lighthouse lab data (median of several runs) and Chrome UX Report field data when you provide a key;
- with your authorisation, Google Search Console data.

An optional analysis step asks the Claude Code or Codex CLI you already use to judge what code cannot, such as whether content answers the query or whether structured data matches the visible page. Every claim must cite collected evidence and quote it word for word, passes validation in code and is checked again by a verifier; claims that fail are dropped with their reason.

Each failed check is also a task for a coding agent, with the files that most likely hold the fix and acceptance checks that `altimeter verify` re-runs against a local build.

## Install

Altimeter needs Node.js 24 or newer (26 is recommended) and, for rendering and Lighthouse, Chrome or Chromium. Set `CHROME_PATH` when Chrome is not found automatically.

```sh
npm install --global @altitud-studio/altimeter
altimeter doctor
```

`altimeter doctor` reports Node.js, Chrome, the Chrome UX Report key and the Claude Code and Codex CLIs it can use. It only asks the CLIs for their version.

## Audit a site

```sh
altimeter audit https://example.com/                 # the page and its site context
altimeter audit https://example.com/ --crawl         # crawl up to 100 pages politely (robots.txt, 2 requests in flight)
altimeter audit https://example.com/ --lang es       # write the report in Spanish (en, es or ca)
```

Each run writes a folder under `altimeter-report/<host>/<UTC time>/`:

| File | Contents |
| --- | --- |
| `report.html` | Self-contained report: no external requests, a strict content security policy, every value from the site escaped. |
| `report.md` | The same report in Markdown. |
| `report.json` | Every finding, its evidence, the score, the coverage and the tasks, with the catalog hash. |
| `FIXES.md` | All tasks in priority order, with the rules for handling text copied from the site. |
| `tasks/<id>.md` | One file per task, small enough to hand to a coding agent. |

`altimeter render report.json --lang ca` writes the report again in another language without collecting anything. `altimeter rules` lists the catalog and `altimeter explain <rule-id>` shows a rule with its thresholds and sources.

Exit status: `0` done, `1` a check failed at the `--fail-on` level or above, `2` error, `3` the page could not be audited (for example a firewall challenge).

## Fix with a coding agent

Text that comes from the audited site is untrusted. Task files put it in fenced `untrusted` blocks and say so: an agent must treat it as data and never follow instructions found inside it.

```sh
altimeter audit https://example.com/ --source ../example-site   # tasks name the files that most likely hold each fix
altimeter verify altimeter-report/example.com/<run>/report.json --task T-1a2b3c4d5e --static dist/
altimeter verify altimeter-report/example.com/<run>/report.json --origin http://127.0.0.1:4321
altimeter compare before/report.json after/report.json
```

- `--source` reads the site's repository (never writes to it, and never sends it anywhere) to point each task at the code that emits the markup or the configuration that answers the request, and to name data files that only hold the observed text and should not change.
- `verify` serves a local build (or uses a local origin), maps the production URLs onto it and runs the task's acceptance checks, and the checks that must keep passing. It exits `0` when they pass, `1` when one fails and `3` when the task cannot be verified locally, such as a certificate or a CDN setting.
- `compare` lists fixed, new and remaining problems, and refuses reports produced with different rule catalogs.

## Model analysis

Analysis runs the Claude Code or Codex CLI installed and signed in on your machine, with your own plan. Altimeter never asks for or reads their credentials.

```sh
altimeter audit https://example.com/ --provider auto        # Claude Code, then Codex; without either, the audit runs without analysis
altimeter audit https://example.com/ --keyword "garden tools" --ai-pages 3 --ai-max-calls 16
altimeter audit https://example.com/ --dry-run prompts/     # write every prompt and the call plan, call nothing
```

- **What is sent.** Excerpts of the audited pages (text, headings, titles, URLs, alt text, structured data and selected headers), the rule entries in scope, the analyst rubric and the deterministic results. Search Console data is never sent.
- **How the CLIs run.** No tools, no MCP servers, no hooks, a read-only sandbox for Codex and an empty working folder for Claude Code; any tool use fails the call. See [SECURITY.md](SECURITY.md).
- **What reaches the report.** Only claims that cite evidence, quote it exactly, stay within the rule's scope and severity and pass a second, verifying call. Model findings never change the score or `--fail-on`. A code candidate the verified analysis confirms becomes a task; one it dismisses leaves the review list.
- **Cost.** Calls count against your Claude or ChatGPT plan. They are capped by `--ai-max-calls` (16 by default), each call carries at most 60 KB, and answers are cached for seven days (`altimeter cache clear` deletes them). API key variables are forwarded only with `--use-api-keys`.

`--provider none` (or `ALTIMETER_PROVIDER=none`) audits without analysis.

## Owner data

Altimeter reads data that only the site's owner can authorise, read-only, from credentials you provide. It never looks for tokens of other tools.

- **Search Console.** `altimeter gsc login --client client_secret.json --remember dpapi` signs in with your own OAuth client and the `webmasters.readonly` scope; `ALTIMETER_GSC_ACCESS_TOKEN` or a service account key in `ALTIMETER_GSC_SA_KEY` also work. `audit --gsc` then adds URL Inspection results (index state, the canonical Google chose, the last crawl, rich result issues), sitemap reports and performance analyses such as pages whose click-through rate is far below the site's own norm. Queries stay on your machine; `--redact-queries` writes numbered labels instead, for a report you want to share. These findings never change the score.
- **Field data.** Set `ALTIMETER_GOOGLE_API_KEY` to a Google Cloud API key with the Chrome UX Report API enabled; the key travels in a request header to Google only.

## How the score works

Only deterministic checks count. For each category the score is 100 × (1 − failed weight / evaluated weight), with weights critical 10, high 5, medium 3 and low 1; the overall score weights categories by their evaluated weight. Checks that could not be evaluated, informational checks, model judgments and owner data never change it, and the report shows the coverage beside the score, so a high score on few evaluated checks reads as such. An indexability gate states separately whether any critical crawling or indexing check failed.

## Limits

- Altimeter observes a site from the outside. It cannot reproduce Google's ranking, Google's location or verify itself as Googlebot by IP: probes with crawler user agents show only how the site answers that string.
- Lab data is not field data. Without a Chrome UX Report key, Core Web Vitals come from Lighthouse only, and the report says so.
- The analysis is a judgment made by a model, checked against the evidence. It is listed separately and never presented as a measurement.
- Tested on Windows 11 and Linux. The model analysis was verified with Claude Code 2.0.59 and Codex CLI 0.166.0-alpha.5.1 and alpha.6; other versions run with a smaller flag set and the report says so. Codex always reads its global `AGENTS.md`; see [SECURITY.md](SECURITY.md#model-analysis).

## Documentation

- [Methodology](docs/methodology.md): what is collected, how rules are evaluated, the score and the tasks.
- [Output format](docs/output-format.md): `report.json`, the task files and the exit codes.
- [Rule catalog](docs/rules.md): every rule with its severity, method, status and sources, and the myths list.
- [SECURITY.md](SECURITY.md): the trust model for audited sites, model analysis and tokens.
- [CONTRIBUTING.md](CONTRIBUTING.md): local checks and how to change the catalog.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for the local checks and [SECURITY.md](SECURITY.md) for private vulnerability reports.

## License

Code is released under the [MIT license](LICENSE), copyright 2026 Altitud Studio S.L.U. The bundled schema.org vocabulary snapshot is available under CC BY-SA 3.0; see [NOTICE](NOTICE).
