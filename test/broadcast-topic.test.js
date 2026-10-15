import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractBroadcasts } from '../src/extract-broadcast.js';
import { parse } from '../src/parse.js';

const html = readFileSync(new URL('./fixtures/broadcast-topic.html', import.meta.url), 'utf8');
test('topic 动态保留自己的标题、正文、链接和 sid，不冒充作品标记', async () => {
  const { broadcasts } = extractBroadcasts(html, '111');
  assert.equal(broadcasts.length, 1);
  const b = broadcasts[0];
  assert.equal(b.sid, '9001');
  assert.equal(b.title, '标题 & 留存');
  assert.equal(b.text, '一段正文。从「页面不存在」到存档');
  assert.equal(b.url, 'https://www.douban.com/topic/7001/?_spm_id=example');
  assert.equal(b.targetTitle, null);
  assert.equal(b.status, null);
  assert.equal(b.visibility, 'public');
  assert.equal(extractBroadcasts(html, '222').broadcasts.length, 0);
  for (const changed of [html.replace('data-atype="topic"', 'data-atype="subject"'), html.replace('/topic/7001/', '/topic/7002/'), html.replace('https://www.douban.com/topic/', 'https://evil.test/topic/')]) {
    assert.equal(extractBroadcasts(changed, '111').broadcasts[0].title, null);
  }
  const source = {
    bundleId: '20261015T000000Z-aaaaaa', status: 'complete',
    manifest: { account: { user_id: '111', username: 'example' } },
    crawlState: new Map(), coverage: new Map(),
    index: [{ capture_id: '20261015T000000Z-aaaaaa#000001', intent: 'broadcast.timeline', route_key: 'broadcast.timeline',
      url: 'https://www.douban.com/people/example/statuses?p=1', verdict: 'ok', surface: 'html', observed_at: '2026-10-15T22:00:00+08:00' }],
    payload: () => html, close() {},
  };
  const result = await parse([source]);
  const record = result.broadcasts[0];
  assert.equal(record.upstream_id, '9001');
  assert.equal(record.url, b.url);
  assert.equal(record.revisions[0].fields.title, b.title);
  assert.ok(record.revisions[0].digests.title);
  assert.equal(result.marks.length, 0);
});
