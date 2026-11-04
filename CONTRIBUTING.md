# Contributing to Altimeter

Changes are proposed through pull requests from a fork or a focused branch. Explain the observable behavior your change adds or fixes. The maintainer controls merges into the protected default branch.

## Local setup

Use Node.js 26, the active LTS line (`.node-version`), and npm. Node.js 24 remains supported until its end of life on 2028-04-30, so the type definitions follow Node.js 24 and the tests run on both lines:

```sh
npm ci
npm run check
```

`npm run check` type-checks the project and runs the tests. Tests run the TypeScript sources directly, so no build step is needed; `npm run build` produces the published `dist/`. Continuous integration runs the same checks on Linux and Windows with Node.js 26 and 24 for every pull request.

`npm run bench` runs the integrated benchmark: about 25 synthetic sites served over HTTPS on loopback, each audited end to end with Chrome, and a table of precision and recall per rule. It needs Chrome or Chromium (`CHROME_PATH`), fails rather than skips without it, and takes a few minutes; CI runs it after `npm run check`. Run it when you change a rule, and see [bench/README.md](bench/README.md) to add a scenario.

## Before opening a pull request

- Keep the change focused and preserve public contracts outside its scope.
- Add behavior tests for relevant failures and boundaries. For regressions, show that the test fails before the fix when practical.
- Preserve valid tests. Do not relax an assertion or silently skip a failure to make the suite pass.
- Keep tokens, audit reports, evidence folders, real Search Console data and downloaded tools out of commits.
- Inspect the staged diff, including new files and dependency lockfile changes.

## Changing the rule catalog

A rule describes behavior that a search engine or a web standard documents. Each rule needs:

- a primary source (official search engine documentation, web.dev, schema.org, an RFC or the WHATWG standard) and the date you verified it;
- fixtures for a page that passes, a page that fails and a page where the rule cannot be evaluated;
- a fix that a developer can act on, without claims about ranking weight that the source does not make.

Industry studies can inform severity but cannot be the only source for a rule. Claims that current guidance contradicts belong in the myths list instead of the catalog.

## Translating reports

Reports are written in English, Spanish or Catalan (`--lang`). Each language keeps its text under `src/i18n/<language>/`:

- `rules/<category>.json`: the title, why, fix and messages of each rule.
- `values.json`: the English words that code writes into message values and evidence labels, such as band names or Search Console states, by parameter name. A key with `{name}` parts is a pattern; each part is translated as a value of the parameter it names.
- `evidence.json`: the evidence labels, keyed by their English template.

The report interface is in `src/i18n/ui.ts`. `src/i18n/en/evidence.json` lists every evidence label of the sources: run `npm run i18n:labels` after adding or changing one. Whatever a Spanish or Catalan file lacks is shown in English. Follow `docs/glossary-es.md` and `docs/glossary-ca.md`, keep every `{placeholder}` and code span, and check a translation with:

```sh
node --test test/i18n-parity.test.ts test/i18n-values.test.ts test/evidence-labels.test.ts test/report-languages.test.ts
```

The parity tests compare a language's values and labels with English once its file has its first entry.

## Reporting a bug or a wrong finding

Include the Altimeter version, operating system, Node.js version, expected behavior, actual behavior and a minimal reproduction with synthetic pages. For a false positive or a missed issue, use the issue form and include the rule id and the relevant excerpt of `report.json`. Do not post private reports or credentials.

For suspected vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue with exploit details.
