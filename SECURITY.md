# Security policy

Altimeter fetches and renders websites that you choose, parses what they return and, when you enable analysis, sends excerpts to the Claude Code or Codex CLI installed on your machine. Audited sites are untrusted input. Altimeter is not a sandbox for hostile sites, and a model's judgment is never treated as a fact.

## Report a vulnerability

Use GitHub's **Report a vulnerability** option on this repository. If it is unavailable, write to info@altitudstudio.ad and ask for a private channel.

Do not put tokens, Search Console or analytics exports, private reports or exploit details in a public issue. A synthetic reproduction, the affected version or commit, your operating system and Node.js version, and the potential impact help us investigate. Fixes are released in a new version of the latest release line.

## Supported versions

| Version | Security fixes |
| --- | --- |
| Latest 0.x release | Yes |
| Older releases | No: upgrade to the latest release |

The threat model, covering untrusted pages, network destinations, model output and the tokens you supply, is documented as each boundary is implemented.
