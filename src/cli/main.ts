#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { version } from '../version.ts';

export const help = `Altimeter ${version}: evidence-based SEO audits.

Usage: altimeter <command> [options]

The audit commands are under development; the README describes the planned interface.

Options:
  -h, --help       Show this help.
  -v, --version    Print the version.
`;

export function main(args: readonly string[] = process.argv.slice(2)): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      options: { help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' } },
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Invalid arguments.'}\n`);
    return 2;
  }
  if (parsed.values.version) {
    process.stdout.write(`${version}\n`);
    return 0;
  }
  if (parsed.values.help || parsed.positionals.length === 0) {
    process.stdout.write(help);
    return 0;
  }
  process.stderr.write(`Unknown command: ${parsed.positionals[0]}. Run "altimeter --help".\n`);
  return 2;
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url)) process.exitCode = main();
