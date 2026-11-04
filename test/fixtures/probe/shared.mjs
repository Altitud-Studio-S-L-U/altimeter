// Shared by the synthetic Claude Code and Codex CLIs of the probe tests: reads the question on stdin, records how
// the double was started next to its scenario file and picks the scenario's response for that question.
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export function loadScenario(url) {
  return JSON.parse(readFileSync(url, 'utf8'));
}

/** Every start is recorded, --version included, so a test can prove that nothing was started at all. */
export function record(scenarioUrl, entry) {
  const details = entry.version ? {} : { cwd: process.cwd(), cwdEntries: readdirSync(process.cwd()), env: Object.keys(process.env) };
  appendFileSync(new URL('./calls.jsonl', scenarioUrl), `${JSON.stringify({ ...entry, ...details, pid: process.pid })}\n`);
}

/**
 * The first response whose `when` text appears in the question and whose `times` budget is not used up, else the
 * scenario's default. Counts live next to the scenario; tests that rely on them run one call at a time.
 */
export function pick(scenario, stdin, scenarioUrl) {
  const counterUrl = new URL('./counter.json', scenarioUrl);
  const seen = existsSync(counterUrl) ? JSON.parse(readFileSync(counterUrl, 'utf8')) : {};
  for (const [index, response] of (scenario.responses ?? []).entries()) {
    if (response.when !== undefined && !stdin.includes(response.when)) continue;
    if (response.times !== undefined && (seen[index] ?? 0) >= response.times) continue;
    seen[index] = (seen[index] ?? 0) + 1;
    writeFileSync(counterUrl, JSON.stringify(seen));
    return response;
  }
  return scenario.default ?? {};
}

export function hang() {
  setInterval(() => {}, 1000);
}

/** Writes events as JSON lines; a response can stall after some of them to simulate a CLI that stops answering. */
export function emit(lines, stallAfter) {
  const shown = stallAfter === undefined ? lines : lines.slice(0, stallAfter);
  process.stdout.write(shown.map(line => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + (shown.length > 0 ? '\n' : ''));
  if (stallAfter !== undefined) hang();
  return stallAfter !== undefined;
}
