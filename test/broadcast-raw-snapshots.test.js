import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '../src/parse.js';
const html = readFileSync(new URL('./fixtures/broadcast-topic.html', import.meta.url), 'utf8');
const bundleId = '20261029T000000Z-aaaaaa';
const baseRow = { capture_id: `${bundleId}#000001`, intent: 'broadcast.timeline', route_key: 'broadcast.timeline',
  surface: 'html', verdict: 'ok', observed_at: '2026-10-29T00:00:00Z', url: 'https://www.douban.com/people/example/statuses?p=1' };
function source(rows) {
  return { bundleId, status: 'complete', manifest: { bundle_id: bundleId, account: { user_id: '111', username: 'example' },
    crawl_scope: { visibility: 'self', operator_mode: 'authenticated', broadcast_reply_snapshot: true } },
    index: rows, crawlState: new Map(), coverage: new Map(), close() {},
    payload(row) { assert.equal(row.intent, 'broadcast.timeline', 'raw replies/detail bytes must never be parsed as personal UGC'); return html; } };
}

test('raw reply and HTML detail captures are traceable without changing any personal entity or revision', async () => {
  const before = await parse([source([baseRow])]);
  const extra = ['broadcast.comments_snapshot', 'broadcast.item'].flatMap((intent, i) => ['ok', 'blocked', 'unknown'].map((verdict, j) => ({
    ...baseRow, capture_id: `${bundleId}#${String(2 + i * 3 + j).padStart(6, '0')}`, intent, route_key: intent,
    surface: i ? 'html' : 'api', verdict, url: i ? 'https://www.douban.com/people/111/status/9001/' : 'https://m.douban.com/rexxar/api/v2/status/9001/comments?start=0&count=20',
  })));
  const after = await parse([source([baseRow, ...extra])]);
  for (const key of ['profile', 'marks', 'subjects', 'broadcasts', 'longform', 'albums', 'doulists', 'groupTopics', 'groupJoins']) {
    assert.deepEqual(after[key], before[key], key);
  }
  assert.equal(after.broadcasts.length, 1);
  assert.equal(after.stats.rawOnlyCaptures.length, extra.length);
  assert.deepEqual(after.stats.rawOnlyCaptures.map(r => r.verdict), ['ok', 'blocked', 'unknown', 'ok', 'blocked', 'unknown']);
  assert.equal(after.stats.rawOnlyCaptures[0].scope, 'first_page_only');
  assert.equal(after.stats.rawOnlyCaptures[3].scope, 'detail_html_only');
  assert.deepEqual(after.warnings, before.warnings);
});
