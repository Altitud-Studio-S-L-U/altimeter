# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-05

### Added

- `altimeter audit`: the response and every redirect hop, robots.txt (RFC 9309), sitemaps, URL variants, an unknown URL, hreflang alternates, crawler user agent probes, TLS, language negotiation and referenced resources; a Googlebot-like render in Chrome plus a scrolled and an unblocked render; Lighthouse lab data and Chrome UX Report field data; and an optional polite crawl (`--crawl`).
- A catalog of 402 rules in seven categories, each citing primary sources with the date they were verified: 340 in the audit itself (13 of them judged only by the optional model analysis), 24 that read owner data and 38 planned. A list of 121 myths documents claims that are never reported.
- Reports in English, Spanish and Catalan (HTML, Markdown and JSON) with a score from deterministic checks only, the coverage beside it and an indexability gate; `altimeter render` writes a report again in another language.
- Tasks for coding agents (`FIXES.md`, `tasks/<id>.md`) with acceptance checks and the checks that must keep passing. With `--source` they also name the files of the site's repository that most likely hold each fix. `altimeter verify` re-runs them against a local build, and `altimeter compare` lists fixed, new and remaining problems.
- Optional model analysis through the Claude Code or Codex CLI: claims must cite and quote evidence, are validated in code and verified by a second call, and never change the score. It has a call cap, a seven-day cache and `--dry-run`. `altimeter doctor [--probe]` checks the environment.
- Owner data, read-only: Search Console (`altimeter gsc login`, URL Inspection, sitemap reports and performance analyses), Bing Webmaster Tools (`--bing`) and the crawler requests in access logs or Cloudflare analytics (`altimeter bots`, `audit --bots-from`), each crawler verified against its operator's IP list or reverse DNS. None of it is sent to a model, except the Search Console queries that `ai-probe --from-gsc` asks the engines. In an audit, `--redact-queries` writes numbered labels instead of search queries.
- `altimeter ai-probe`: a small, sampled check of whether the web search answers of Claude Code and Codex cite the site.
- `altimeter rules`, `explain` and `cache clear`.
- Continuous integration on Linux and Windows with Node.js 26 and 24, CodeQL and OpenSSF Scorecard analysis, and a release workflow that publishes to npm with provenance from Node.js 26.
