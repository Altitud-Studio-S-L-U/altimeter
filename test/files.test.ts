import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { readRegularFile } from '../src/core/files.ts';
import { startsLikeSvg } from '../src/rules/helpers.ts';

let work: string;

before(async () => {
  work = await mkdtemp(join(tmpdir(), 'altimeter-files-'));
});

after(async () => {
  await rm(work, { recursive: true, force: true });
});

describe('readRegularFile', () => {
  test('reads a regular file within the limit', async () => {
    await writeFile(join(work, 'answer.json'), '{"ok":true}');
    assert.deepEqual(await readRegularFile(join(work, 'answer.json'), 1024), { text: '{"ok":true}' });
  });

  test('tells a missing file, a folder and a file over the limit apart', async () => {
    assert.deepEqual(await readRegularFile(join(work, 'missing.json'), 1024), { problem: 'missing' });
    await mkdir(join(work, 'folder'));
    assert.deepEqual(await readRegularFile(join(work, 'folder'), 1024), { problem: 'not-regular' });
    await writeFile(join(work, 'large.json'), 'x'.repeat(2048));
    assert.deepEqual(await readRegularFile(join(work, 'large.json'), 1024), { problem: 'too-large' });
    assert.deepEqual(await readRegularFile(join(work, 'large.json'), 2048), { text: 'x'.repeat(2048) });
  });

  test('never reads through a symbolic link', async t => {
    await writeFile(join(work, 'secret.txt'), 'not for the report');
    try {
      await symlink(join(work, 'secret.txt'), join(work, 'link.json'), 'file');
    } catch {
      // Windows lets only administrators and developer mode create symbolic links.
      t.skip('symbolic links cannot be created here');
      return;
    }
    assert.deepEqual(await readRegularFile(join(work, 'link.json'), 1024), { problem: 'not-regular' });
  });
});

describe('startsLikeSvg', () => {
  test('accepts an svg element after an XML declaration, comments and a doctype', () => {
    assert.equal(startsLikeSvg('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), true);
    const prolog = `\uFEFF  <?xml version="1.0" encoding="UTF-8"?>\n<!-- Generator: an editor -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<!-- second -->\n<SVG viewBox="0 0 1 1">`;
    assert.equal(startsLikeSvg(prolog), true);
  });

  test('rejects other documents and unfinished prologs', () => {
    assert.equal(startsLikeSvg('<!doctype html><html><svg></svg></html>'), false);
    assert.equal(startsLikeSvg('<?xml version="1.0"?><rss></rss>'), false);
    assert.equal(startsLikeSvg('<!-- never closed <svg>'), false);
    assert.equal(startsLikeSvg('<svgfoo>'), false);
  });

  test('stays linear on long runs of comments', () => {
    const started = performance.now();
    assert.equal(startsLikeSvg(`<!--${'--><!--'.repeat(20_000)}`), false);
    assert.equal(startsLikeSvg(`${'<!---->'.repeat(20_000)}<svg>`), true);
    assert.ok(performance.now() - started < 1000);
  });
});
