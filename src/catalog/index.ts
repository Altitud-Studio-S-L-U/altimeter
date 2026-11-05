import { createHash } from 'node:crypto';
import type { Category, Myth, RuleMeta } from '../core/types.ts';
import mythEntries from './myths.json' with { type: 'json' };
import ai from './rules/ai.json' with { type: 'json' };
import content from './rules/content.json' with { type: 'json' };
import crawl from './rules/crawl.json' with { type: 'json' };
import intl from './rules/intl.json' with { type: 'json' };
import perf from './rules/perf.json' with { type: 'json' };
import schema from './rules/schema.json' with { type: 'json' };
import tech from './rules/tech.json' with { type: 'json' };

/** Rule entries as stored, one file per category; `test/catalog.test.ts` validates them. */
export const rulesByCategory = { crawl, content, perf, schema, intl, tech, ai } as unknown as Readonly<Record<Category, readonly RuleMeta[]>>;

export const rules: readonly RuleMeta[] = Object.values(rulesByCategory).flat();

export const myths: readonly Myth[] = mythEntries as unknown as readonly Myth[];

const byId = new Map(rules.map(rule => [rule.id, rule]));

export function rule(id: string): RuleMeta | undefined {
  return byId.get(id);
}

/** Identifies the catalog a report was produced with; reports from different catalogs are not comparable. */
export const catalogHash: string = createHash('sha256').update(JSON.stringify({ rules, myths })).digest('hex');
