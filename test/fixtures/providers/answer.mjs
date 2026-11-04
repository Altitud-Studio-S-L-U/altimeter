// Shared by the synthetic Claude and Codex doubles: reads the request on stdin, records the call next to the
// scenario file and builds an answer from the scenario, resolving placeholders against the evidence it was sent.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export function loadScenario(url) {
  return JSON.parse(readFileSync(url, 'utf8'));
}

export function record(scenarioUrl, entry) {
  appendFileSync(new URL('./calls.jsonl', scenarioUrl), `${JSON.stringify({ ...entry, pid: process.pid, cwd: process.cwd(), env: Object.keys(process.env) })}\n`);
}

/**
 * The first response whose `when` text appears in the request and whose `times` budget is not used up, else
 * the scenario's default. Counts live next to the scenario; tests that rely on them run one call at a time.
 */
export function pick(scenario, stdin, scenarioUrl) {
  const counterUrl = new URL('./counter.json', scenarioUrl);
  let seen = {};
  try {
    seen = JSON.parse(readFileSync(counterUrl, 'utf8'));
  } catch {
    // No call has been counted yet.
  }
  for (const [index, response] of (scenario.responses ?? []).entries()) {
    if (response.when !== undefined && !stdin.includes(response.when)) continue;
    if (response.times !== undefined && (seen[index] ?? 0) >= response.times) continue;
    seen[index] = (seen[index] ?? 0) + 1;
    writeFileSync(counterUrl, JSON.stringify(seen));
    return response;
  }
  return scenario.default ?? {};
}

function parseLines(stdin) {
  const items = [];
  const sections = [];
  const claims = [];
  for (const line of stdin.split('\n')) {
    if (!line.startsWith('{')) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value.section === 'string') sections.push(value);
    else if (typeof value.id === 'string' && /^V\d+$/.test(value.id) && typeof value.rule === 'string') claims.push(value);
    else if (typeof value.id === 'string' && typeof value.text === 'string') items.push(value);
  }
  return { items, sections, claims };
}

// {{id:phrase}} is the first evidence item containing the phrase, {{section:P1:text}} the id of a page's
// section and {{url:P1}} the page's URL, all as the request presented them.
function resolveString(text, context) {
  return text.replace(/\{\{(id|section|url):([^}]*)\}\}/g, (match, kind, argument) => {
    if (kind === 'id') {
      const item = context.items.find(entry => entry.text.includes(argument) && /^[AE]\d+$/.test(entry.id));
      return item ? item.id : 'A999999';
    }
    if (kind === 'section') {
      const [page, name] = argument.split(':');
      const section = context.sections.find(entry => entry.page === page && entry.section === name);
      return section?.id ?? 'A999998';
    }
    const section = context.sections.find(entry => entry.page === argument);
    return section?.url ?? 'https://unknown.invalid/';
  });
}

function resolve(value, context) {
  if (typeof value === 'string') return resolveString(value, context);
  if (Array.isArray(value)) return value.map(entry => resolve(entry, context));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolve(entry, context)]));
  return value;
}

/** The structured answer: a verification built from the claims it was sent, or the scenario's answer. */
export function answerFor(response, stdin) {
  const context = parseLines(stdin);
  if (response.verdicts !== undefined) {
    const results = [];
    for (const claim of context.claims) {
      const verdict = response.verdicts[claim.rule] ?? response.verdicts['*'] ?? 'supported';
      if (verdict === 'omit') continue;
      results.push({ id: claim.id, verdict, note: `Checked ${claim.rule}.` });
    }
    return { results };
  }
  return resolve(response.answer ?? {}, context);
}

export function hang() {
  setInterval(() => {}, 1000);
}
