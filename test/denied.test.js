import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parse.js';

test('bundle/1.5 denied 是已知的不可信捕获，不读取正文、不产生删除或内容记录', async () => {
  const bundleId = '20261110T000000Z-aaaaaa';
  const src = { bundleId, status: 'complete',
    manifest: { spec_version: 'bundle/1.5', bundle_id: bundleId, account: { user_id: '111' } },
    index: [{ capture_id: `${bundleId}#000001`, intent: 'review.item', route_key: 'review.item',
      surface: 'html', verdict: 'denied', observed_at: '2026-11-10T00:00:00Z',
      url: 'https://movie.douban.com/review/7575457/' }],
    crawlState: new Map(), coverage: new Map(), close() {},
    payload() { assert.fail('权限错误正文不能进入内容解析'); },
  };
  const result = await parse([src]);
  assert.deepEqual(result.longform, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.stats.skipped['verdict:denied'], 1);
});

test('旧版有效影评与新版 denied 混合解析不清空历史、不制造修订，输入顺序无关', async () => {
  const url = 'https://movie.douban.com/review/7575457/';
  const source = (bundleId, version, verdict) => ({ bundleId, status: 'complete',
    manifest: { spec_version: version, bundle_id: bundleId, account: { user_id: '111' } },
    index: [{ capture_id: `${bundleId}#000001`, intent: 'review.item', route_key: 'review.item',
      verdict, surface: 'html', url,
      observed_at: verdict === 'ok' ? '2026-11-01T00:00:00Z' : '2026-11-10T00:00:00Z' }],
    crawlState: new Map([['review.item', { route_key: 'review.item', enumeration: 'full',
      contiguous: verdict === 'ok', gaps: verdict === 'ok' ? [] : [{ reason: 'access_denied', url }] }]]),
    coverage: new Map(), close() {}, payload() {
      assert.equal(verdict, 'ok');
      return `<h1><span property="v:summary">历史影评</span></h1>
        <div class="main-bd" id="review-7575457-content"><div id="link-report-7575457">
        <div class="review-content" data-url="${url}">应保留的历史正文</div></div></div>`;
    } });
  const old = source('20261101T000000Z-aaaaaa', 'bundle/1.4', 'ok');
  const denied = source('20261110T000000Z-bbbbbb', 'bundle/1.5', 'denied');
  const baseline = await parse([old]);
  assert.equal(baseline.longform.length, 1);
  assert.equal(baseline.longform[0].revisions.length, 1);
  for (const sources of [[old, denied], [denied, old]]) {
    const result = await parse(sources);
    assert.deepEqual(result.longform, baseline.longform);
    assert.deepEqual(result.warnings, baseline.warnings);
    assert.equal(result.stats.skipped['verdict:denied'], 1);
  }
});
