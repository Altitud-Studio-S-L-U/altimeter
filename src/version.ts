import { readFileSync } from 'node:fs';

// Resolves to the package root from both src/ and dist/.
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

export const version: string = manifest.version;
