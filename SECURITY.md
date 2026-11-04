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

## Audited sites and the network

- **Destinations.** Altimeter fetches only `http` and `https` URLs. Every connection, including each redirect hop, checks the addresses the host name resolves to and refuses loopback, private (RFC 1918), link-local, carrier-grade NAT, unique local IPv6, documentation, reserved and unspecified addresses, as well as IPv4-mapped, NAT64 and 6to4 addresses that embed a refused IPv4 address. IP literals in decimal, octal or hexadecimal are normalised by the URL parser first, so they are checked like any other address. `--allow-private-network` lifts this for staging and local sites; `verify` allows loopback only for the local build it serves.
- **Chrome.** Pages render in Chrome started over a pipe (no debugging port), with its sandbox on. All of its traffic goes through a local proxy that applies the same address checks, so a page cannot reach your network through DNS rebinding. Each render uses a fresh profile without cookies or service workers; downloads are denied and dialogs and pop-ups closed.
- **What is kept.** Responses are size-limited before parsing. Text copied from a site is untrusted everywhere: the reports escape it, terminal output strips control and escape sequences, and task files fence it in `untrusted` blocks that tell coding agents never to follow instructions found inside.

## Tokens and owner data

- **Where they come from.** Search Console access comes from your own OAuth client (`altimeter gsc login`, scope `webmasters.readonly`, PKCE on a loopback address), a short-lived token in `ALTIMETER_GSC_ACCESS_TOKEN` or a service account key file named by `ALTIMETER_GSC_SA_KEY`. The Chrome UX Report key comes from `ALTIMETER_GOOGLE_API_KEY` and travels in a request header. Altimeter never reads the credentials of other tools, such as gcloud, wrangler, browsers or the provider CLIs.
- **Where they go.** Tokens are sent only to the API they belong to and never appear in reports, logs, prompts or error messages. A stored Search Console login is protected with Windows DPAPI for your user, or written to a file only you can read when you choose `--remember file`; `altimeter gsc logout` revokes and deletes it.
- **Owner data.** Search Console data stays on your machine and never reaches a model. Queries can identify people: `--redact-queries` writes numbered labels instead of them.

## Model analysis

The optional analysis runs the Claude Code or Codex CLI already installed and signed in on your machine. Altimeter never asks for or reads their credentials.

- **What is sent.** Each call carries trusted text first (the analyst rubric, the catalog entries in scope, the myths list and the deterministic results) and then excerpts of the audited pages: text, headings, titles, URLs, alt text, structured data and selected headers. Site text is stripped of control, zero-width and bidirectional characters, encoded as JSON and placed between delimiters that carry a random value chosen for each run, so a page cannot close the block. A call never exceeds 60 KB. A dry run writes every prompt and the call plan to a folder without starting either CLI.
- **How the CLIs run.** They are started with explicit arguments and no shell. Claude Code runs with `--tools ""`, `--permission-mode plan`, an empty MCP configuration, no setting sources and hooks disabled. Codex runs `exec` with a read-only sandbox, an ephemeral session, user configuration and rules ignored, and its shell, unified exec, apps, plugins and web search switched off; any command, file change, tool call or web search in its event stream fails the call. Each call has a deadline, a shared output budget for stdout and stderr (stderr is never stored or printed), and on timeout or cancellation the process tree Altimeter started is terminated.
- **Environment.** The CLIs receive the variables they need to start, find their own sign-in and reach the network, including `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and `SSL_CERT_DIR`. `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_API_KEY` and `OPENAI_API_KEY` are forwarded only when you opt in, so a key exported for another tool is never spent silently.
- **Working folders.** Claude Code stores sessions per working directory, so every Claude call runs in one stable, empty folder: `%LOCALAPPDATA%\altimeter\provider-cwd` on Windows, `~/Library/Caches/altimeter/provider-cwd` on macOS and `$XDG_CACHE_HOME/altimeter/provider-cwd` (default `~/.cache/altimeter/provider-cwd`) elsewhere. Altimeter creates it when missing and refuses to run Claude when anything has been placed in it, because files such as `CLAUDE.md` there would be read as instructions. Codex runs in a new private temporary folder that holds the schema and the answer and is removed after the call.
- **Cache.** Answers are kept for seven days next to that folder, in `altimeter/ai-cache`, keyed by the prompt (without the run's random value or request-specific values such as dates, cookies, nonces and CSRF tokens), the provider and CLI version, the model, the schema, the catalog slice, the myths, the rubric, the target keywords and the role. Entries are checked again on every read, and the cache can be cleared.
- **What reaches the report.** A model answer is data. Every claim is checked by code: the schema, that cited evidence exists in the request, that the rule is in scope, that quotes appear in the item they cite, that judgment-based severity stays at medium or below, that the page was audited, that no note repeats a myth or recommends new markets or languages, that proposals add no numbers, contacts, ratings, years, superlatives or links the site does not show, and that absence is claimed only from complete evidence. A second, batched call then checks each surviving finding against only its cited evidence. Findings that fail are dropped with their reason; findings whose verification could not run are listed separately. None of them change the score, the task list or `--fail-on`.
- **Verified versions.** The flags above were checked against Claude Code 2.0.59 and Codex CLI 0.166.0-alpha.5.1 on Windows. Other versions run with the smaller flag set verified earlier and the report says so.
