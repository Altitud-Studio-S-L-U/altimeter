import type { RuleImplementation } from './engine.ts';
import { implementations as ai } from './ai/index.ts';
import { implementations as content } from './content/index.ts';
import { implementations as crawl } from './crawl/index.ts';
import { implementations as intl } from './intl/index.ts';
import { implementations as perf } from './perf/index.ts';
import { implementations as schema } from './schema/index.ts';
import { implementations as tech } from './tech/index.ts';

const all = [...crawl, ...content, ...perf, ...schema, ...intl, ...tech, ...ai];

export const implementations: ReadonlyMap<string, RuleImplementation> = new Map(all.map(implementation => [implementation.id, implementation]));

if (implementations.size !== all.length) throw new Error('Two rule implementations share an id');
