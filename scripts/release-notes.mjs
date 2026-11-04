import { readFileSync } from 'node:fs';

// Prints the CHANGELOG section of one release, used as the GitHub release notes.
const version = (process.argv[2] ?? '').replace(/^v/u, '');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
  process.stderr.write('Usage: node scripts/release-notes.mjs vX.Y.Z\n');
  process.exit(2);
}
const lines = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').split(/\r?\n/u);
const heading = new RegExp(`^## \\[?${version.replaceAll('.', '\\.')}\\]?(?:\\s|$)`, 'u');
const start = lines.findIndex(line => heading.test(line));
if (start === -1) {
  process.stderr.write(`CHANGELOG.md has no section for ${version}.\n`);
  process.exit(1);
}
const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
const notes = lines.slice(start + 1, next === -1 ? lines.length : next).join('\n').trim();
if (notes === '') {
  process.stderr.write(`The CHANGELOG.md section for ${version} is empty.\n`);
  process.exit(1);
}
process.stdout.write(`${notes}\n`);
