/**
 * 标记的身份：**哪些观测算同一条记录**。
 *
 * 规范：doubak-data-specs/canonical/IDENTITY.md §2.3
 *
 * ## 为什么这一层值得单独一组测试
 *
 * 它错了不报错，而且**看起来像数据变多了**——同一条标记在不同年代的观测各自成
 * 一条记录，产出里标记数翻倍、修订史被劈成两半，每一条记录单独看都完全正常。
 *
 * 这不是假想的情形。IDENTITY.md §2.2 那张表自己就写着：`data-cid` 只有
 * **2023-12 之后**抓的页面才有。所以只要一个目录里同时有那之前和之后的档案，
 * 每一条跨越那条线的标记都会一分为二。实测把前代工具 2022-12 → 2024-08 的档案
 * 导进来跑一遍：**2526 个作品出了 4050 条标记**。
 *
 * ## 为什么用手搓的档案而不是真实语料
 *
 * 真实语料里这条线在 2023-12，钉住它等于钉住一个日期。这里要钉的是**规则**：
 * 同一个作品，一次观测有上游 id、一次没有。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parse.js';

/** 一条影视标记的最小列表页。`cid` 为 null 就是 2023-12 之前的样子。 */
function listPage({ cid, date, comment }) {
  return `<h1>我看过的电影(1)</h1>
<div class="item comment-item" ${cid ? `data-cid="${cid}"` : ''}>
  <div class="info"><ul>
    <li class="title"><a href="https://movie.douban.com/subject/1234567/"><em>某部电影</em></a></li>
    <li class="intro">2016 / 日本 / 剧情</li>
    <li><span class="rating4-t"></span><span class="date">${date}</span>
        <span class="tags">标签: 剧情 日本</span></li>
    <li><span class="comment">${comment}</span></li>
    <li class="clearfix opt-ln"><a>修改</a></li>
  </ul></div>
</div>`;
}

/**
 * 一份内存里的档案，实现 `parse()` 认的那八项契约。
 *
 * 顺带把契约本身钉在这里：多一项少一项，这个文件就跑不起来。
 */
function memorySource({ bundleId, observedAt, html }) {
  const row = {
    capture_id: `${bundleId}#000001`,
    url: 'https://movie.douban.com/people/u/collect?start=0',
    intent: 'interest.list.movie.collect',
    route_key: 'interest.movie.collect',
    surface: 'html',
    verdict: 'ok',
    observed_at: observedAt,
  };
  return {
    status: 'complete',
    manifest: { bundle_id: bundleId, account: { user_id: '82160871', username: 'u' } },
    bundleId,
    index: [row],
    crawlState: new Map(),
    coverage: new Map(),
    payload: () => html,
    close: () => {},
  };
}

describe('data-cid 是 2023-12 才有的，两边的观测必须认成同一条', () => {
  const before = memorySource({
    bundleId: '20221226T104500Z-aaaaaa',
    observedAt: '2022-12-26T10:45:00+08:00',
    html: listPage({ cid: null, date: '2022-12-01', comment: '早年的短评' }),
  });
  const after = memorySource({
    bundleId: '20240811T124600Z-bbbbbb',
    observedAt: '2024-08-11T12:46:00+08:00',
    html: listPage({ cid: '987654321', date: '2022-12-01', comment: '改过的短评' }),
  });

  test('**一条记录，两次修订** —— 不是两条记录', async () => {
    const out = await parse([before, after]);
    assert.equal(out.marks.length, 1,
      '同一条标记按有没有 data-cid 分裂成了两条：修订史会被劈成两半，而且看起来像数据变多了');
    assert.equal(out.marks[0].revisions.length, 2, '短评改过，该有两次修订');
    assert.deepEqual(
      out.marks[0].revisions.map((r) => r.fields.comment),
      ['早年的短评', '改过的短评'],
      '修订要按观测时间排',
    );
  });

  test('喂进去的顺序不影响结果', async () => {
    // 摄取必须与档案的处理顺序无关（INGESTION.md §5.2）。这里两种顺序走的是
    // 归并里两条不同的分支：先退化键后上游 id 要「搬家」，反过来是直接命中。
    const forward = await parse([before, after]);
    const backward = await parse([after, before]);
    assert.equal(backward.marks.length, 1);
    assert.deepEqual(
      backward.marks[0].revisions.map((r) => r.fields.comment),
      forward.marks[0].revisions.map((r) => r.fields.comment),
    );
  });

  test('上游 id 补上了，但**身份层仍然写 degraded_key**', async () => {
    // 它回答的是「这条记录的身份最弱靠到了哪一层」。早年那次观测确确实实是靠
    // 退化键认回来的，改写成 upstream_id 会把那件事掩盖掉——而读者判断「这些
    // 修订真的是同一条记录吗」时，要看的正是最弱的那一环。
    const out = await parse([before, after]);
    assert.equal(out.marks[0].upstream_id, '987654321');
    assert.equal(out.marks[0].identity_layer, 'degraded_key');
  });

  test('全程都有上游 id 的，身份层就是 upstream_id', async () => {
    const a = memorySource({
      bundleId: '20240811T124600Z-cccccc', observedAt: '2024-08-11T12:46:00+08:00',
      html: listPage({ cid: '987654321', date: '2022-12-01', comment: '一' }),
    });
    const b = memorySource({
      bundleId: '20250811T124600Z-dddddd', observedAt: '2025-08-11T12:46:00+08:00',
      html: listPage({ cid: '987654321', date: '2022-12-01', comment: '二' }),
    });
    const out = await parse([a, b]);
    assert.equal(out.marks.length, 1);
    assert.equal(out.marks[0].identity_layer, 'upstream_id');
  });

  test('**同一个作品的两个上游 id 不合并** —— 那是标了、删了、又重新标', async () => {
    // 这一层信息只有 data-cid 给得出，正是它比退化键强的地方。归并时把它丢掉，
    // 等于把一次真实的「删除并重标」抹成一次编辑。
    const first = memorySource({
      bundleId: '20240811T124600Z-eeeeee', observedAt: '2024-08-11T12:46:00+08:00',
      html: listPage({ cid: '111111111', date: '2022-12-01', comment: '第一次标' }),
    });
    const second = memorySource({
      bundleId: '20250811T124600Z-ffffff', observedAt: '2025-08-11T12:46:00+08:00',
      html: listPage({ cid: '222222222', date: '2025-08-01', comment: '重新标的' }),
    });
    const out = await parse([first, second]);
    assert.equal(out.marks.length, 2, '两个 data-cid 是两条上游记录，不该并成一条');
  });

  test('作品记录始终只有一条 —— 它按 (媒介, 作品 id) 认，与 data-cid 无关', async () => {
    const out = await parse([before, after]);
    assert.equal(out.subjects.length, 1);
  });
});
