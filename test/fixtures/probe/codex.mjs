// A synthetic Codex CLI for the probe tests. It never contacts a model or the web: it records how it was started,
// writes the final answer to --output-last-message and prints the JSONL events its scenario describes.
import { writeFileSync } from 'node:fs';
import { emit, hang, loadScenario, pick, readStdin, record } from './shared.mjs';

function events(response) {
  const searches = (response.searches ?? []).flatMap((query, index) => [
    { type: 'item.started', item: { id: `ws_${index + 1}`, type: 'web_search', query } },
    { type: 'item.completed', item: { id: `ws_${index + 1}`, type: 'web_search', query, action: { type: 'search', query } } },
  ]);
  return [
    { type: 'thread.started', thread_id: 'double-thread' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'reasoning_1', type: 'reasoning', text: 'Looking for current sources.' } },
    ...searches,
    ...(response.tool ? [{ type: 'item.started', item: { id: 'tool_1', type: response.tool, command: 'echo probe', status: 'in_progress' } }] : []),
    ...(response.answer !== undefined ? [{ type: 'item.completed', item: { id: 'msg_1', type: 'agent_message', text: response.messageText ?? response.answer } }] : []),
    ...(response.failTurn ? [{ type: 'turn.failed', error: { message: 'double failure' } }] : []),
    ...(response.noCompleted ? [] : [{ type: 'turn.completed', usage: { input_tokens: 1800, cached_input_tokens: 0, output_tokens: 350 } }]),
  ];
}

export async function run(scenarioUrl) {
  const scenario = loadScenario(scenarioUrl);
  const args = process.argv.slice(2);
  if (args.includes('--version')) {
    record(scenarioUrl, { version: true, args });
    process.stdout.write(`codex-cli ${scenario.version ?? '0.166.0-alpha.5.1'}\n`);
    return;
  }
  const stdin = await readStdin();
  record(scenarioUrl, { args, stdin });
  const response = pick(scenario, stdin, scenarioUrl);
  if (response.hang) return hang();
  const answerFile = args[args.indexOf('--output-last-message') + 1];
  if (response.answer !== undefined && !response.noAnswerFile) writeFileSync(answerFile, response.fileText ?? response.answer);
  if (emit(response.lines ?? events(response), response.stallAfter)) return;
  process.exitCode = response.exitCode ?? 0;
}
