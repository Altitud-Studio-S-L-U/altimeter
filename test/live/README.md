# Live checks

Files in this folder stay on your machine: everything except this README is ignored by git. Use it for oracles, the
expectations you hold about a real site you are allowed to audit, so that a change to the rules can be checked against
that site without publishing what the audit finds there.

An oracle is a JSON array of expectations. Each one names a rule and whether its failure must be `present`, must be
`absent`, or may appear but never above `maxSeverity` (`capped`, for checks that depend on the lab run), and optionally
the page path (or `site`) and the failure reason:

```json
[
  { "ruleId": "crawl-sitemap-lastmod", "expect": "present", "scope": "site", "reason": "missing", "maxSeverity": "low" },
  { "ruleId": "content-hidden-text", "expect": "absent", "includeCandidates": true, "note": "carousel slides are not hidden text" }
]
```

Audit the site, then compare the report with the oracle:

```sh
node src/cli/main.ts audit https://example.com/ --crawl --provider none --out .tmp/live
node scripts/check-oracle.ts .tmp/live/example.com/<run>/report.json test/live/example.oracle.json
```

The comparison exits with 1 when an expectation is not met. Candidates that still need judgment are left out unless
an entry sets `includeCandidates`.
