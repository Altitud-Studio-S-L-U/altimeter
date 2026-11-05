import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isAllowed, normalizeRobotsPath, parseRobots, robotsAvailability, robotsByteLimit, selectGroup } from '../src/fetch/robots.ts';

function allowed(robots: string, path: string, tokens: string[] = ['googlebot']): boolean {
  return isAllowed(parseRobots(robots), tokens, path).allowed;
}

describe('path matching (examples from Google\'s robots.txt specification)', () => {
  const cases: Array<[string, string[], string[]]> = [
    ['/fish', ['/fish', '/fish.html', '/fish/salmon.html', '/fishheads', '/fishheads/yummy.html', '/fish.php?id=anything'],
      ['/Fish.asp', '/catfish', '/?id=fish', '/desert/fish']],
    ['/fish*', ['/fish', '/fish.html', '/fish/salmon.html', '/fishheads', '/fishheads/yummy.html', '/fish.php?id=anything'],
      ['/Fish.asp', '/catfish', '/?id=fish', '/desert/fish']],
    ['/fish/', ['/fish/', '/fish/?id=anything', '/fish/salmon.htm'], ['/fish', '/fish.html', '/animals/fish/', '/Fish/Salmon.asp']],
    ['/*.php', ['/index.php', '/filename.php', '/folder/filename.php', '/folder/filename.php?parameters', '/folder/any.php.file.html', '/filename.php/'],
      ['/', '/windows.PHP']],
    ['/*.php$', ['/filename.php', '/folder/filename.php'], ['/filename.php?parameters', '/filename.php/', '/filename.php5', '/windows.PHP']],
    ['/fish*.php', ['/fish.php', '/fishheads/catfish.php?parameters'], ['/Fish.PHP']],
  ];
  for (const [pattern, matches, misses] of cases) {
    test(`disallow ${pattern}`, () => {
      const robots = `User-agent: *\nDisallow: ${pattern}\n`;
      for (const path of matches) assert.equal(allowed(robots, path), false, `${pattern} should match ${path}`);
      for (const path of misses) assert.equal(allowed(robots, path), true, `${pattern} should not match ${path}`);
    });
  }
});

describe('wildcards', () => {
  test('decides patterns with many wildcards in linear time', () => {
    for (const [wildcards, length] of [[10, 40], [25, 2000]] as const) {
      const robots = `User-agent: *\nDisallow: /${'*a'.repeat(wildcards - 1)}*b\n`;
      const started = performance.now();
      assert.equal(allowed(robots, `/${'a'.repeat(length)}`), true);
      assert.equal(allowed(robots, `/${'a'.repeat(length)}b`), false);
      assert.ok(performance.now() - started < 1000, `${wildcards} wildcards against ${length} characters`);
    }
  });

  test('match as a regular expression would on short patterns', () => {
    let seed = 1;
    const draw = (alphabet: string, length: number) => Array.from({ length }, () => alphabet[(seed = (seed * 48271) % 2147483647) % alphabet.length]).join('');
    for (let index = 0; index < 3000; index++) {
      const pattern = `/${draw('ab*$', 1 + (index % 7))}`;
      const path = `/${draw('ab$', index % 9)}`;
      const anchored = pattern.endsWith('$');
      const source = (anchored ? pattern.slice(0, -1) : pattern).split('*').map(part => part.replaceAll('$', '\\$')).join('.*');
      const matches = new RegExp(`^${source}${anchored ? '$' : ''}`, 'u').test(path);
      assert.equal(allowed(`User-agent: *\nDisallow: ${pattern}\n`, path), !matches, `${pattern} against ${path}`);
    }
  });
});

describe('rule precedence', () => {
  test('the longest matching rule wins', () => {
    assert.equal(allowed('User-agent: *\nAllow: /p\nDisallow: /\n', '/page'), true);
    assert.equal(allowed('User-agent: *\nAllow: /page\nDisallow: /*.htm\n', '/page.htm'), false);
  });

  test('allow wins a tie', () => {
    assert.equal(allowed('User-agent: *\nAllow: /folder\nDisallow: /folder\n', '/folder/page'), true);
  });

  test('an anchored allow can carve out the root', () => {
    const robots = 'User-agent: *\nAllow: /$\nDisallow: /\n';
    assert.equal(allowed(robots, '/'), true);
    assert.equal(allowed(robots, '/page.htm'), false);
  });

  test('an empty disallow allows everything', () => {
    assert.equal(allowed('User-agent: *\nDisallow:\n', '/anything'), true);
  });

  test('robots.txt itself is always allowed', () => {
    assert.equal(allowed('User-agent: *\nDisallow: /\n', '/robots.txt'), true);
  });

  test('paths compare case-sensitively', () => {
    assert.equal(allowed('User-agent: *\nDisallow: /Private\n', '/private'), true);
    assert.equal(allowed('User-agent: *\nDisallow: /Private\n', '/Private/x'), false);
  });
});

describe('groups', () => {
  const robots = [
    'User-agent: googlebot-news',
    'Disallow: /news-only',
    '',
    'User-agent: Googlebot',
    'User-agent: bingbot',
    'Disallow: /shared',
    '',
    'User-agent: *',
    'Disallow: /',
    '',
    'User-agent: googlebot',
    'Disallow: /second-googlebot-group',
  ].join('\n');

  test('user-agent matching is case-insensitive and combines groups with the same token', () => {
    const selected = selectGroup(parseRobots(robots), ['googlebot']);
    assert.equal(selected.matchedToken, 'googlebot');
    assert.deepEqual(selected.rules.map(rule => rule.pattern), ['/shared', '/second-googlebot-group']);
  });

  test('a specific group replaces the wildcard group entirely', () => {
    assert.equal(allowed(robots, '/anything', ['googlebot']), true);
    assert.equal(allowed(robots, '/anything', ['otherbot']), false);
  });

  test('the most specific token is used before its parent token', () => {
    assert.equal(allowed(robots, '/shared', ['googlebot-news', 'googlebot']), true);
    assert.equal(allowed(robots, '/news-only', ['googlebot-news', 'googlebot']), false);
  });

  test('version suffixes in the user-agent line are ignored', () => {
    assert.equal(allowed('User-agent: Googlebot/2.1\nDisallow: /x\n', '/x'), false);
  });

  test('no group means no restrictions', () => {
    assert.equal(isAllowed(parseRobots('Sitemap: https://example.com/s.xml\n'), ['googlebot'], '/x').matchedToken, undefined);
    assert.equal(allowed('Sitemap: https://example.com/s.xml\n', '/x'), true);
  });
});

describe('parsing', () => {
  test('records sitemaps, unsupported fields, typos, orphan rules and invalid lines', () => {
    const file = parseRobots([
      'Disallow: /before-any-agent',
      'User-agent: *',
      'Crawl-delay: 10',
      'Noindex: /secret',
      'Dissallow: /typo',
      'this line has no separator',
      'Sitemap: https://example.com/sitemap.xml # trailing comment',
    ].join('\r\n'));
    assert.deepEqual(file.orphanRules.map(entry => entry.value), ['/before-any-agent']);
    assert.deepEqual(file.unsupported.map(entry => entry.key), ['crawl-delay', 'noindex']);
    assert.deepEqual(file.misspelled.map(entry => entry.key), ['dissallow']);
    assert.deepEqual(file.invalid.map(entry => entry.line), [6]);
    assert.deepEqual(file.sitemaps.map(entry => entry.value), ['https://example.com/sitemap.xml']);
    assert.equal(allowed('User-agent: *\nDissallow: /typo\n', '/typo'), false);
  });

  test('ignores content after 500 KiB', () => {
    const padding = '#'.repeat(robotsByteLimit);
    const file = parseRobots(`User-agent: *\n${padding}\nDisallow: /late\n`);
    assert.equal(file.truncated, true);
    assert.equal(isAllowed(file, ['googlebot'], '/late').allowed, true);
  });

  test('normalizes percent-encoding before comparing', () => {
    assert.equal(normalizeRobotsPath('/%7Ejoe/index.html'), '/~joe/index.html');
    assert.equal(normalizeRobotsPath('/a%2fb'), '/a%2Fb');
    assert.equal(normalizeRobotsPath('/año'), '/a%C3%B1o');
    assert.equal(allowed('User-agent: *\nDisallow: /a%C3%B1o\n', '/año'), false);
    assert.equal(allowed('User-agent: *\nDisallow: /año\n', '/a%c3%b1o'), false);
  });
});

describe('fetch outcomes', () => {
  test('maps status codes to Google\'s handling', () => {
    assert.equal(robotsAvailability(200, Buffer.from('User-agent: *\nDisallow: /')).kind, 'parsed');
    assert.equal(robotsAvailability(404, undefined).kind, 'unrestricted');
    assert.equal(robotsAvailability(403, undefined).kind, 'unrestricted');
    assert.equal(robotsAvailability(429, undefined).kind, 'unreachable');
    assert.equal(robotsAvailability(503, undefined).kind, 'unreachable');
    assert.equal(robotsAvailability(undefined, undefined).kind, 'unreachable');
    assert.equal(robotsAvailability(301, undefined, true).kind, 'unrestricted');
  });
});
