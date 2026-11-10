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
