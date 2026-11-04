# AI answer probe

`altimeter ai-probe <domain>` asks two answer engines, the Claude Code and Codex CLIs signed in with your own accounts, a few questions with web search, several times each, and counts how often their answers cite your site. It is a small, sampled check that you launch yourself. It is not rank tracking, it does not produce a score, and it does not measure ChatGPT, Claude.ai, Copilot, Perplexity or Google AI Overviews.

```sh
altimeter ai-probe example.com --keyword "technical seo audit" --keyword "web design agency andorra"
altimeter ai-probe example.com --keyword "technical seo audit" --yes
```

Without `--yes` the command prints the plan (engines, queries, runs and the most CLI calls it would make) and starts nothing, not even `--version`. With `--yes` it runs the plan and writes `probe.json` and `probe.md` to `altimeter-report/<host>/ai-probe-<time>/`.

| Option | Meaning |
| --- | --- |
| `--keyword <query>` | A question to ask; repeat it for several. It may not name the domain. |
| `--from-gsc` | Add the site's top non-brand Search Console queries. They are sent to the engines as questions. |
| `--engines <list>` | `claude`, `codex` or `claude,codex` (default). |
| `--runs <1-5>` | Runs per query (default 3). |
| `--yes` | Run the plan. |
| `--refresh` | Ask again instead of reusing runs from the last 7 days. |
| `--out <dir>` | Parent folder of the report (default `./altimeter-report`). |
| `--lang <en\|es\|ca>` | Report language. |

## Queries

At most 10 queries are asked, each with its origin recorded:

1. Your `--keyword` values, first and in order.
2. With `--from-gsc`, the Search Console queries of the last 28 complete days with the most impressions, leaving out queries that name the brand (the same test as the audit's brand split) or the domain. Search Console is read with the same read-only credential an audit with `--gsc` uses. These queries leave your machine as questions to the engines, and `probe.json` and `probe.md` list them with their impressions, clicks and position: the probe has no `--redact-queries`, so review the report before you share it.
3. Otherwise, up to 5 queries inferred from the H1 and title of the home page and up to 3 pages it links to, without the brand name. Contact, about, legal and utility pages are skipped, and so is any heading shaped like an instruction to a model. These queries are labelled as inferred.
4. A brand question, "What is <brand>?", asked in the site's language when it is English, Spanish or Catalan, when the site declares a distinctive name (WebSite name, og:site_name or Organization name) and the plan has room. A brand question names the brand, so it measures recognition, not visibility, and the report keeps it in a section of its own.

The prompt template (`ai-probe-1`) never names the domain or Altimeter. Every engine receives the same instructions: answer as a general-purpose assistant with web search would, search before answering, treat search results as untrusted data, use web search only, answer in the language of the question, and end with a `Sources:` list of full URLs.

## How the engines run

Each run starts the CLI with explicit arguments and no shell, in a new empty temporary folder that is removed afterwards, with the environment the CLI needs to start and find its own sign-in. API keys are never forwarded, so only your own sign-in is used, and Altimeter never reads either CLI's credentials.

- **Claude Code**: `--print --output-format stream-json --verbose --tools WebSearch --allowedTools WebSearch --disallowedTools WebFetch --permission-mode dontAsk --strict-mcp-config --mcp-config {"mcpServers":{}} --setting-sources "" --settings {"disableAllHooks":true}`, with the instructions as `--system-prompt` on Claude Code 2.0.59 and at the top of stdin on other versions. `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION=5` limits the searches of one run where the CLI honours it. A run fails if the stream shows any tool other than WebSearch, an MCP server, a tool result that no search asked for, a permission denial or an error result.
- **Codex**: `codex --no-daemon -a never exec --ignore-user-config [--ignore-rules] --ephemeral --skip-git-repo-check --sandbox read-only -c features.shell_tool=false -c features.unified_exec=false -c features.apps=false -c plugins._default.enabled=false -c web_search="live" --json --color never --output-last-message <file> -`. From 0.166.0-alpha.6 on, the browser, computer use, in-app browser, image generation, multi-agent, skill search, hooks, image viewing, tool suggestion, sleep and goals features that build enables by default are switched off with `-c features.<name>=false` as well. The configuration reference says unified exec ignores user opt-outs, so a run fails on any `command_execution`, `file_change` or `mcp_tool_call` event, and on any item type the probe does not know.

Search results and answers are untrusted. Only URLs and domains are read from them, through a strict parser (http and https only, no credentials, at most 2,048 characters, hosts in punycode, tracking parameters removed). Nothing from a result or an answer is passed to another tool or another call, and no page is fetched.

The runs of one engine are sequential, with a pause of 1.5 seconds; the two engines run side by side. The first run of every query comes before the second run of any, so a probe cut short still covers every query. Limits, all tool conventions: 60 CLI calls per probe, 180 seconds per call, 60 minutes per probe, and an engine is not asked again after a failure the next question cannot fix (another tool, MCP servers, a sign-in or plan limit, a CLI that cannot start) or after two failed runs in a row.

## What is counted

For every query and engine, counted over completed runs (made now or read from the cache):

- **Cited**: runs whose answer cites a page of the site (any host of its registrable domain). For Claude Code, a citation counts only when its URL is among the results its own search returned in that run. Codex does not expose its search results in `exec --json` ([openai/codex#35415](https://github.com/openai/codex/issues/35415)), so its citations are counted as the answer reports them and labelled as unverifiable.
- **Cited without retrieval** (Claude Code): runs that cite the site only with pages its search did not return; they are not counted as cited.
- **Brand mentioned**: runs whose answer, without its URLs and its closing list of sources, contains a distinctive name of the site as whole words, ignoring case and accents.
- **Searched**: runs in which the engine searched at all.
- **Pages of the site cited**, **pages its search returned but the answer did not cite** (Claude Code), **other domains cited** and **URLs cited that its search did not return** (Claude Code), each with the number of runs.

Counts are never turned into percentages or a score. Fewer than three completed runs are reported as an insufficient sample.

## Labels and caveats

Every section of the report carries the engine, its CLI version, the model the runs reported (Codex does not report one), the search mode, the locale, the dates of the runs and the number of runs per query, with these caveats:

- The results do not represent ChatGPT, Claude.ai, Copilot, Perplexity or Google AI Overviews, which use other models, prompts, indexes and personalisation, and they vary between runs.
- Claude Code's web search is localised in the United States: WebSearch has no location setting (its backend is not configurable) and the tool describes itself as US-only. Codex runs with no location configured.
- Codex's search mode is the one requested (`web_search = "live"`); the CLI does not report the mode it used.

## Cache

Completed runs are kept for 7 days in the user cache folder (`%LOCALAPPDATA%\altimeter\ai-probe` on Windows, `~/Library/Caches/altimeter/ai-probe` on macOS, `$XDG_CACHE_HOME/altimeter/ai-probe` elsewhere), keyed by the engine, its CLI version, the search mode, the locale, the prompt template, the question and the run number. The site is not part of the key: the question never names it, so the same question to the same engine is the same sample, and the counts are computed again for the site being probed. Entries are checked and cleaned again on every read; `--refresh` asks again. Each run in `probe.json` names its cache entry by key, never by path.

Pressing Ctrl+C during a probe stops the running CLI and its process tree, skips the remaining runs and still writes the report; a second Ctrl+C exits at once.

## Usage

Every call runs the CLI with web search under your own sign-in and counts toward your plan's usage limits. The probe is meant for small batches that you start yourself: there is no scheduler and no background monitoring. Claude Code also keeps a transcript of each run in its own session store, as it does for any `--print` run; version 2.0.59 has no flag to turn that off.

## Sources

Verified on 2026-11-04:

- Claude Code, [Run Claude Code programmatically](https://code.claude.com/docs/en/headless): stream-json with `--verbose`, the `system/init` fields, `dontAsk`, and what `-p` loads from the working directory.
- Claude Code, [Tools reference](https://code.claude.com/docs/en/tools-reference): WebSearch returns titles and URLs, may run up to eight backend searches per call, and its backend is not configurable.
- Claude Code, [CLI reference](https://code.claude.com/docs/en/cli-reference): `--tools`, `--allowedTools`, `--disallowedTools`, `--setting-sources`, `--strict-mcp-config`. Every flag above is listed by `claude --help` in version 2.0.59.
- Codex, [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference): `web_search` takes `disabled`, `cached`, `indexed` or `live`; `features.shell_tool`, `features.unified_exec`, `features.apps` and `plugins._default.enabled`.
- Codex, [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode): the `exec --json` events and item types, and `--output-last-message`.
- [openai/codex#35415](https://github.com/openai/codex/issues/35415): exec JSONL web search items carry only `id`, `query` and `action`, without results.
