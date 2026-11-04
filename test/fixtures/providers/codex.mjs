// A synthetic Codex CLI. It never contacts a model: it records how it was called, writes the final answer
// to --output-last-message and prints the JSONL event stream that its scenario describes.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { answerFor, hang, loadScenario, pick, readStdin, record } from './answer.mjs';

export async function run(scenarioUrl) {
  const scenario = loadScenario(scenarioUrl);
  const args = process.argv.slice(2);
  if (args.includes('--version')) {
    process.stdout.write(`codex-cli ${scenario.version ?? '0.166.0-alpha.5.1'}\n`);
    return;
  }
  const stdin = await readStdin();
  const value = flag => args[args.indexOf(flag) + 1];
  const schemaFile = value('--output-schema');
  const answerFile = value('--output-last-message');
  record(scenarioUrl, { args, stdin, schema: existsSync(schemaFile) ? JSON.parse(readFileSync(schemaFile, 'utf8')) : null });
  const response = pick(scenario, stdin, scenarioUrl);
  if (response.hang) return hang();
  if (response.answerText !== undefined) writeFileSync(answerFile, response.answerText);
  else if (!response.noAnswer) writeFileSync(answerFile, JSON.stringify(answerFor(response, stdin)));
  const events = response.events ?? [
    { type: 'thread.started', thread_id: 'double-thread' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'reasoning-1', type: 'reasoning', text: 'Reading the evidence.' } },
    ...(response.tool ? [{ type: 'item.started', item: { id: 'tool-1', type: response.tool } }] : []),
    { type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text: 'Done.' } },
    ...(response.failTurn ? [{ type: 'turn.failed', error: { message: 'double failure' } }] : []),
    ...(response.noCompleted ? [] : [{ type: 'turn.completed', usage: { input_tokens: 900, cached_input_tokens: 0, output_tokens: 250 } }]),
  ];
  process.stdout.write(`${events.map(event => JSON.stringify(event)).join('\n')}\n`);
  process.exitCode = response.exitCode ?? 0;
}
