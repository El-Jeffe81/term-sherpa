'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRobots, isAllowed, crawlDelayFor } = require('../cli/src/robots');
const T = 'tc-collect';

test('empty robots allows everything; Disallow: / blocks everything', () => {
  assert.equal(isAllowed(parseRobots(''), T, '/terms'), true);
  assert.equal(isAllowed(parseRobots('User-agent: *\nDisallow:'), T, '/terms'), true);
  assert.equal(isAllowed(parseRobots('User-agent: *\nDisallow: /'), T, '/terms'), false);
});
test('longest match wins; allow wins ties; wildcard and $', () => {
  const p = parseRobots('User-agent: *\nDisallow: /legal/\nAllow: /legal/terms\nDisallow: /*.pdf$\nDisallow: /a*b');
  assert.equal(isAllowed(p, T, '/legal/privacy'), false);
  assert.equal(isAllowed(p, T, '/legal/terms'), true);
  assert.equal(isAllowed(p, T, '/x/file.pdf'), false);
  assert.equal(isAllowed(p, T, '/x/file.pdf.html'), true);
  assert.equal(isAllowed(p, T, '/axxb'), false);
  const tie = parseRobots('User-agent: *\nAllow: /p\nDisallow: /p');
  assert.equal(isAllowed(tie, T, '/p'), true);
});
test('specific group beats *; our token is matched case-insensitively', () => {
  const p = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: TC-Collect\nDisallow: /private');
  assert.equal(isAllowed(p, T, '/terms'), true);
  assert.equal(isAllowed(p, T, '/private/x'), false);
});
test('stacked user-agent lines, comments, crawl-delay', () => {
  const p = parseRobots('# hi\nUser-agent: foo\nUser-agent: tc-collect # us\nDisallow: /no # c\nCrawl-delay: 7\n');
  assert.equal(isAllowed(p, T, '/no'), false);
  assert.equal(isAllowed(p, T, '/yes'), true);
  assert.equal(crawlDelayFor(p, T), 7);
});
test('query strings are part of the matched path', () => {
  const p = parseRobots('User-agent: *\nDisallow: /*?session=');
  assert.equal(isAllowed(p, T, '/terms?session=1'), false);
  assert.equal(isAllowed(p, T, '/terms'), true);
});
