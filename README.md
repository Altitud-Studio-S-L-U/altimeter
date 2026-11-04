# Altimeter

Evidence-based SEO audits for websites, with AI analysis that is checked against the evidence before it reaches the report.

[![CI](https://github.com/Altitud-Studio-S-L-U/altimeter/actions/workflows/ci.yml/badge.svg)](https://github.com/Altitud-Studio-S-L-U/altimeter/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Altitud-Studio-S-L-U/altimeter/actions/workflows/codeql.yml/badge.svg)](https://github.com/Altitud-Studio-S-L-U/altimeter/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Altitud-Studio-S-L-U/altimeter/badge)](https://scorecard.dev/viewer/?uri=github.com/Altitud-Studio-S-L-U/altimeter)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 24](https://img.shields.io/badge/Node.js-%E2%89%A524-43853d?logo=node.js&logoColor=white)](package.json)
[![Security policy](https://img.shields.io/badge/security-policy-44546a)](SECURITY.md)

> **Status:** in development. Version 0.1.0 is not published yet, and the commands below describe the interface being built.

Altimeter collects the facts that search engines act on: HTTP responses and redirects, robots.txt, sitemaps, the raw and the rendered HTML, structured data, Lighthouse lab data and Chrome UX Report field data. It evaluates them against a rule catalog in which every rule cites a primary source, such as Google Search Central, web.dev, schema.org or an RFC, together with the date that source was last verified. Rules that the guidance does not support, such as keyword density or fixed title lengths, are documented as myths and never reported.

An optional analysis step asks the Claude Code or Codex CLI you already use to judge what code cannot, such as whether content answers the search intent or whether structured data matches the visible page. Every claim must cite collected evidence and quote it verbatim; claims that fail that check are dropped.

Each fix in the report is also a task for coding agents, with acceptance checks that `altimeter verify` re-runs against a local build.

```sh
altimeter audit https://example.com/ --crawl --lang en
altimeter verify altimeter-report/example.com/<run>/report.json --static dist/
```

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for the local checks and [SECURITY.md](SECURITY.md) for private vulnerability reports.

## License

Code is released under the [MIT license](LICENSE), copyright 2026 Altitud Studio S.L.U.
