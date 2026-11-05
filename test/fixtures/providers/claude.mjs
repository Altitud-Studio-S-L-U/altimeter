// A synthetic Claude Code CLI. It never contacts a model: it records how it was called and prints the
// --output-format json envelope that its scenario describes.
import { answerFor, hang, loadScenario, pick, readStdin, record } from './answer.mjs';

export async function run(scenarioUrl) {
  const scenario = loadScenario(scenarioUrl);
  const args = process.argv.slice(2);
  if (args.includes('--version')) {
    process.stdout.write(`${scenario.version ?? '2.0.59'} (Claude Code)\n`);
    return;
  }
  const stdin = await readStdin();
  record(scenarioUrl, { args, stdin });
  const response = pick(scenario, stdin, scenarioUrl);
  if (response.hang) return hang();
  if (response.stdout !== undefined) {
    process.stdout.write(response.stdout);
  } else {
    const envelope = {
      type: 'result',
      subtype: response.subtype ?? 'success',
      is_error: response.isError ?? false,
      ...(response.omitStructured ? {} : { structured_output: answerFor(response, stdin) }),
      total_cost_usd: response.costUsd ?? 0.0125,
      usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 100 },
      modelUsage: { [response.model ?? 'claude-double-model']: {} },
      session_id: 'double-session',
      permission_denials: response.permissionDenials ?? [],
    };
    process.stdout.write(JSON.stringify(response.envelope ?? envelope));
  }
  process.exitCode = response.exitCode ?? 0;
}
