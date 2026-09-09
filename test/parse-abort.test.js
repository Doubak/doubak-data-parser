/**
 * **两万页的解析要叫得停。**
 *
 * 报上来的原话是「we need a button to stop the export because it could take really
 * long time if I have ~20k pages to parse」。而 `parse()` 的逐页循环里原来一处能停下来
 * 的地方都没有：扩展里按下「导出」之后就只能等，或者关掉整个面板——那样连已经打开的
 * 档案句柄都一起没了。
 *
 * 判据有两半，缺一不可：
 *
 * - **真的停下来**：抛出之后不许再处理下一页（否则「停」只是把结果丢掉，两万页照跑）；
 * - **认得出是「用户按了停」**：`error.name === 'AbortError'`，与平台的
 *   `AbortSignal.throwIfAborted()` 一致。分不出来的话，界面会把一次主动取消
 *   显示成一张红色的「导出失败」——而这个项目已经为「一句正确的话指向错误的下一步」
 *   付过好几次代价。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parse } from '../src/parse.js';

/** 一个够用的假源：`parse()` 只认那八个成员。 */
function fakeSource(n) {
  const rows = Array.from({ length: n }, (_, i) => ({
    capture_id: `20260909T000000Z-aaaaaa#${String(i + 1).padStart(6, '0')}`,
    url: `https://movie.douban.com/people/me/collect?start=${i * 15}&sort=time`,
    surface: 'html',
    verdict: 'ok',
    http_status: 200,
    observed_at: `2026-09-09T00:00:${String(i % 60).padStart(2, '0')}+08:00`,
    // `intent` 是**一个字符串**，照真实索引里的写（`intent: "interest.list.movie.collect"`）
    // ——第一版写成了对象，`parse()` 当场 `row.intent?.startsWith is not a function`。
    intent: 'interest.list.movie.collect',
  }));
  const opened = [];
  return {
    opened,
    src: {
      status: 'complete',
      bundleId: '20260909T000000Z-aaaaaa',
      manifest: { bundle_id: '20260909T000000Z-aaaaaa', account: { user_id: '1', username: 'u' } },
      index: rows,
      crawlState: new Map(),
      coverage: new Map(),
      async payload(row) { opened.push(row.capture_id); return '<html></html>'; },
      async close() {},
    },
  };
}

describe('解析要叫得停', () => {
  test('一开始就 abort：一页都不读', async () => {
    const { src, opened } = fakeSource(50);
    const c = new AbortController();
    c.abort();
    await assert.rejects(() => parse([src], { signal: c.signal }), (e) => {
      assert.equal(e.name, 'AbortError', '认不出是「用户按了停」');
      assert.match(e.message, /已取消/);
      return true;
    });
    assert.equal(opened.length, 0, '已经 abort 了还去取字节');
  });

  test('**跑到一半 abort：真的停下来**，不是把结果丢掉', async () => {
    // 「停」如果只是最后不返回结果，两万页照样跑完——用户按下去之后还要等几分钟，
    // 而界面已经说停了。判据是**后面的页一页都没碰**。
    const { src, opened } = fakeSource(50);
    const c = new AbortController();
    let seen = 0;
    await assert.rejects(
      () => parse([src], {
        signal: c.signal,
        onProgress: () => { seen += 1; if (seen === 10) c.abort(); },
      }),
      (e) => e.name === 'AbortError',
    );
    // 第 10 页报完进度就 abort，所以第 10 页的字节不该再取。
    assert.equal(opened.length, 9, `停下来之后又读了 ${opened.length - 9} 页`);
  });

  test('不给 signal 就照常跑完 —— 这条路是加上去的，不是必需的', async () => {
    const { src, opened } = fakeSource(5);
    const out = await parse([src]);
    assert.equal(opened.length, 5);
    assert.ok(out.marks);
  });

  test('signal 没 abort 时不影响任何东西', async () => {
    const { src } = fakeSource(5);
    const c = new AbortController();
    const a = await parse([src], { signal: c.signal });
    const b = await parse([fakeSource(5).src]);
    assert.deepEqual(a.stats, b.stats, '带着一个没触发的 signal 跑出来的结果不一样');
  });
});
