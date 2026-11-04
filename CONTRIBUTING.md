# Contributing to Altimeter

Changes are proposed through pull requests from a fork or a focused branch. Explain the observable behavior your change adds or fixes. The maintainer controls merges into the protected default branch.

## Local setup

Use Node.js 24 or newer and npm:

```sh
npm ci
npm run check
```

`npm run check` type-checks the project and runs the tests. Tests run the TypeScript sources directly, so no build step is needed; `npm run build` produces the published `dist/`. Continuous integration runs the same checks on Linux and Windows for every pull request.

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

## Reporting a bug or a wrong finding

Include the Altimeter version, operating system, Node.js version, expected behavior, actual behavior and a minimal reproduction with synthetic pages. For a false positive or a missed issue, use the issue form and include the rule id and the relevant excerpt of `report.json`. Do not post private reports or credentials.

For suspected vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue with exploit details.
