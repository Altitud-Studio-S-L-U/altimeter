// A synthetic Claude Code CLI for the probe tests. It never contacts a model or the web: it records how it was
// started and prints the stream-json events its scenario describes, including WebSearch results in several shapes.
import { emit, hang, loadScenario, pick, readStdin, record } from './shared.mjs';

function resultContent(search) {
  const links = search.links ?? [];
  const query = search.query ?? 'double query';
  switch (search.format ?? 'links-json') {
    case 'links-json':
      return `Web search results for query: "${query}"\n\nLinks: ${JSON.stringify(links)}\n\nA summary written from the results, which also names https://summary-only.example/page.`;
    case 'blocks':
      return [{ type: 'text', text: `Web search results for query: "${query}"` }, { type: 'text', text: `Links: ${JSON.stringify(links)}` }];
    case 'markdown':
      return [{ type: 'text', text: `Results for ${query}:\n${links.map(link => `- [${link.title}](${link.url})`).join('\n')}` }];
    case 'objects':
      return links.map(link => ({ type: 'web_search_result', title: link.title, url: link.url }));
    case 'structured-only':
      return 'Search finished.';
    default:
      return 'No results.';
  }
}

function stream(response) {
  const model = response.model ?? 'claude-double-model';
  const events = [{ type: 'system', subtype: 'init', session_id: 'double', tools: ['WebSearch'], mcp_servers: response.mcpServers ?? [], model, permissionMode: 'dontAsk' }];
  for (const [index, search] of (response.searches ?? []).entries()) {
    const id = `toolu_double_${index + 1}`;
    events.push({ type: 'assistant', message: { model, role: 'assistant', content: [{ type: 'tool_use', id, name: search.tool ?? 'WebSearch', input: { query: search.query ?? 'double query' } }] }, parent_tool_use_id: null });
    events.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: search.resultFor ?? id, content: resultContent(search), ...(search.isError ? { is_error: true } : {}) }] },
      parent_tool_use_id: null,
      ...(search.format === 'structured-only' ? { tool_use_result: { query: search.query, results: [{ tool_use_id: 'srvtoolu_double', content: search.links ?? [] }] } } : {}),
    });
  }
  for (const retry of response.retries ?? []) events.push({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3, retry_delay_ms: 10, error_status: 429, error: retry });
  if (response.answer !== undefined) events.push({ type: 'assistant', message: { model, role: 'assistant', content: [{ type: 'text', text: response.answer }] }, parent_tool_use_id: null });
  if (!response.noResult) {
    events.push({
      type: 'result',
      subtype: response.subtype ?? 'success',
      is_error: response.isError ?? false,
      result: response.resultText ?? response.answer ?? '',
      total_cost_usd: response.costUsd ?? 0.02,
      usage: { input_tokens: 2100, output_tokens: 400, cache_read_input_tokens: 50 },
      modelUsage: { [model]: {} },
      permission_denials: response.permissionDenials ?? [],
      session_id: 'double',
    });
  }
  return events;
}

export async function run(scenarioUrl) {
  const scenario = loadScenario(scenarioUrl);
  const args = process.argv.slice(2);
  if (args.includes('--version')) {
    record(scenarioUrl, { version: true, args });
    process.stdout.write(`${scenario.version ?? '2.0.59'} (Claude Code)\n`);
    return;
  }
  const stdin = await readStdin();
  record(scenarioUrl, { args, stdin });
  const response = pick(scenario, stdin, scenarioUrl);
  if (response.hang) return hang();
  if (emit(response.lines ?? stream(response), response.stallAfter)) return;
  process.exitCode = response.exitCode ?? 0;
}
