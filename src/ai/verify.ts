import type { Report } from '../report/model.ts';
import { cleanText } from '../report/sanitize.ts';
import { buildPack, catalogSlice, maxPackBytes, type EvidencePack, type PackEntry, type PackSection } from './pack.ts';
import { passDefinition } from './passes.ts';
import { validateSchema, type Schema } from './schema.ts';
import type { SiteStrings } from './site.ts';
import { cleanDisplay } from './text.ts';
import type { Confidence, DroppedClaim, PassId } from './types.ts';
import { scopeKey, type DraftFinding } from './validate.ts';

export interface VerifiedFinding extends DraftFinding {
  readonly verification: 'supported' | 'partial' | 'unverified';
}

export interface VerificationRequest {
  readonly pass: PassId;
  readonly pack: EvidencePack;
  readonly schema: Schema;
  /** V1, V2 and so on, for the findings that fit in the request. */
  readonly keys: ReadonlyMap<string, DraftFinding>;
  /** Findings left out because the request reached its size limit. */
  readonly overflow: readonly DraftFinding[];
  readonly catalog: string;
}

export interface VerificationOutcome {
  readonly kept: VerifiedFinding[];
  readonly unverified: VerifiedFinding[];
  readonly dropped: DroppedClaim[];
}

const instructions = `You are the verifier. Another analyst made the claims below about an audited site. Decide for each claim, only from the evidence included with it, whether the evidence supports it:

- supported: the evidence clearly shows what the claim says.
- partial: the evidence shows part of it, or the claim goes further than the evidence.
- unsupported: the evidence does not show it, or contradicts it.

Judge each claim on its own, without outside knowledge, and add no new findings. Return one result per claim id, with a note of one English sentence (at most 200 characters) saying why.`;

function evidenceEntries(finding: DraftFinding, strings: SiteStrings, report: Report): PackEntry[] {
  const deterministic = new Map(report.evidence.map(item => [item.id, item]));
  const entries: PackEntry[] = [];
  for (const id of finding.evidenceIds) {
    const item = strings.items.get(id);
    if (item) {
      entries.push({ id, label: item.label, text: item.text, ...(item.href ? { href: item.href } : {}), ...(item.hidden ? { hidden: item.hidden } : {}), complete: item.complete });
      continue;
    }
    const slice = strings.slices.find(entry => entry.id === id);
    if (slice) {
      entries.push({ id, label: `the whole ${slice.name} section (${slice.items.length} items${slice.complete ? '' : ', not complete'})`, text: '', complete: slice.complete });
      continue;
    }
    const fact = deterministic.get(id);
    if (fact) entries.push({ id, label: cleanText(fact.label, 300), text: cleanText(fact.excerpt ?? '', 2000), complete: fact.complete });
  }
  return entries;
}

function claimSection(key: string, finding: DraftFinding, strings: SiteStrings, report: Report): PackSection {
  const claim: PackEntry[] = [{ id: key, label: 'analyst note', text: finding.notes.en, complete: true }];
  for (const quote of finding.quotes) claim.push({ id: quote.evidenceId, label: 'quoted by the analyst', text: quote.text, complete: true });
  return { name: `claim ${key}`, complete: true, entries: [...claim, ...evidenceEntries(finding, strings, report)] };
}

function claimLine(key: string, finding: DraftFinding): string {
  return JSON.stringify({
    id: key,
    rule: finding.rule.id,
    title: finding.rule.title,
    page: finding.page.label,
    scope: finding.scope.kind,
    verdict: finding.verdict,
    reasonCode: finding.reasonCode,
    claim: finding.outcome === 'fail' ? (finding.absence ? 'the problem exists because something is missing' : 'the problem exists') : 'the evidence shows no problem, or a legitimate pattern',
  });
}

export function verificationSchema(keys: readonly string[]): Schema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['results'],
    properties: {
      results: {
        type: 'array',
        maxItems: keys.length,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'verdict', 'note'],
          properties: {
            id: { type: 'string', enum: keys },
            verdict: { type: 'string', enum: ['supported', 'partial', 'unsupported'] },
            note: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
  };
}

/**
 * One batched request per pass: each surviving finding with only the evidence it cites. Findings that do not
 * fit within the size limit stay unverified rather than being sent in a second call.
 */
export function buildVerificationRequest(pass: PassId, findings: readonly DraftFinding[], strings: SiteStrings, report: Report, nonce: string, limitBytes = maxPackBytes): VerificationRequest {
  const included: Array<[string, DraftFinding]> = [];
  const overflow: DraftFinding[] = [];
  let pack: EvidencePack | undefined;
  const assemble = (entries: ReadonlyArray<readonly [string, DraftFinding]>) => buildPack({
    trusted: `# Verification of ${passDefinition(pass).heading} findings\n\n${instructions}\n\n## Claims\n\n${entries.map(([key, finding]) => claimLine(key, finding)).join('\n')}\n`,
    sections: entries.map(([key, finding]) => claimSection(key, finding, strings, report)),
    limitBytes: Number.MAX_SAFE_INTEGER,
    nonce,
  });
  for (const finding of findings) {
    const key = `V${included.length + 1}`;
    const candidate = assemble([...included, [key, finding]]);
    if (candidate.bytes > limitBytes) {
      overflow.push(finding);
      continue;
    }
    included.push([key, finding]);
    pack = candidate;
  }
  const rules = [...new Map(included.map(([, finding]) => [finding.rule.id, finding.rule])).values()];
  return {
    pass,
    pack: pack ?? assemble([]),
    schema: verificationSchema(included.map(([key]) => key)),
    keys: new Map(included),
    overflow,
    catalog: catalogSlice(rules, new Set(), rule => rule.maxSeverity),
  };
}

const lower: Readonly<Record<Confidence, Confidence | undefined>> = { high: 'medium', medium: 'low', low: undefined };

function dropped(finding: DraftFinding, reason: 'verification-unsupported' | 'verification-partial-low', note: string): DroppedClaim {
  return {
    pass: finding.pass,
    role: 'verifier',
    kind: 'finding',
    page: finding.page.key,
    ruleId: finding.rule.id,
    reason,
    ...(note ? { detail: note } : {}),
    claim: { ruleId: finding.rule.id, scope: scopeKey(finding.scope), verdict: finding.verdict, reasonCode: finding.reasonCode, evidenceIds: finding.evidenceIds, note: finding.notes.en },
  };
}

export function allUnverified(findings: readonly DraftFinding[]): VerificationOutcome {
  return { kept: [], unverified: findings.map(finding => ({ ...finding, verification: 'unverified' as const })), dropped: [] };
}

/**
 * Applies the verifier's answer: supported keeps a finding, partial lowers its confidence one level (a low
 * finding has no level left and is dropped), unsupported drops it. A finding the verifier did not answer, or
 * an answer that does not match the schema, leaves findings unverified.
 */
export function applyVerification(value: unknown, request: VerificationRequest): VerificationOutcome {
  const outcome: VerificationOutcome = { kept: [], unverified: request.overflow.map(finding => ({ ...finding, verification: 'unverified' as const })), dropped: [] };
  const record = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (!record || !Array.isArray(record.results) || Object.keys(record).some(key => key !== 'results')) {
    outcome.unverified.push(...allUnverified([...request.keys.values()]).unverified);
    return outcome;
  }
  const answers = new Map<string, { verdict: string; note: string }>();
  const itemSchema = request.schema.properties!.results!.items!;
  for (const entry of record.results) {
    if (validateSchema(entry, itemSchema).length > 0) continue;
    const result = entry as { id: string; verdict: string; note: string };
    if (!answers.has(result.id)) answers.set(result.id, { verdict: result.verdict, note: cleanDisplay(result.note, 200) });
  }
  for (const [key, finding] of request.keys) {
    const answer = answers.get(key);
    if (!answer) {
      outcome.unverified.push({ ...finding, verification: 'unverified' });
      continue;
    }
    if (answer.verdict === 'supported') {
      outcome.kept.push({ ...finding, verification: 'supported' });
      continue;
    }
    if (answer.verdict === 'unsupported') {
      outcome.dropped.push(dropped(finding, 'verification-unsupported', answer.note));
      continue;
    }
    const confidence = lower[finding.confidence];
    if (confidence === undefined) {
      outcome.dropped.push(dropped(finding, 'verification-partial-low', answer.note));
      continue;
    }
    outcome.kept.push({ ...finding, confidence, verification: 'partial', adjustments: [...finding.adjustments, `verification-partial:${finding.confidence}->${confidence}`] });
  }
  return outcome;
}
