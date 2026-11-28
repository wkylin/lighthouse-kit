import assert from 'node:assert/strict'
import test from 'node:test'
import { pageCandidate } from '../src/discover.mjs'

const candidate = (value, base = 'https://example.com/app/') => pageCandidate(value, base, 'https://example.com')

test('discovery resolves relative links, preserves queries and stays on the exact origin', () => {
  assert.equal(candidate('../about?lang=zh').page, '/about?lang=zh')
  assert.equal(candidate('/products?id=1').url.href, 'https://example.com/products?id=1')
  for (const url of ['https://elsewhere.test/', 'http://example.com/', 'https://example.com:444/', '//elsewhere.test/', 'javascript:alert(1)', 'mailto:user@example.com', 'data:text/html,hello', '/#//['])
    assert.equal(candidate(url), null, url)
})

test('discovery deduplicates ordinary anchors, query ordering and trailing slash aliases', () => {
  assert.equal(candidate('/about#intro').page, '/about')
  assert.equal(candidate('/about/').key, candidate('/about').key)
  assert.equal(candidate('/find?b=2&a=1#intro').key, candidate('/find?a=1&b=2').key)
  assert.notEqual(candidate('/find?page=1').key, candidate('/find?page=2').key)
})

test('discovery retains hash-router routes and the full explicit entry URL', () => {
  assert.equal(candidate('/#/products?id=1').page, '/#/products?id=1')
  assert.equal(candidate('/#!/about').page, '/#!/about')
  assert.notEqual(candidate('/#/a').key, candidate('/#/b').key)
  const entry = pageCandidate('https://example.com/start?x=1#intro', 'https://example.com/', 'https://example.com', { entry: true })
  assert.equal(entry.page, '/start?x=1#intro')
  assert.equal(entry.key, candidate('/start?x=1').key)
})

test('discovery skips assets and logout actions while accepting HTML page URLs', () => {
  for (const url of ['/app.js', '/style.css?v=2', '/logo.PNG', '/manual.pdf', '/feed.xml', '/data.json', '/archive.zip', '/font.woff2', '/logout', '/account/sign-out', '/auth?action=logout', '/#/logout', '/#!/account/sign-out', '/#/auth?action=logout'])
    assert.equal(candidate(url), null, url)
  for (const url of ['/about.html', '/index.php', '/products', '/downloads', '/logout-help', '/#/logout-help'])
    assert.ok(candidate(url), url)
})

test('discovery detects filesystem aliases caused by repeated path separators', () => {
  assert.equal(candidate('/a//b').slug, candidate('/a/b').slug)
  assert.notEqual(candidate('/a//b').key, candidate('/a/b').key)
})
