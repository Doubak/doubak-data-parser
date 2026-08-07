/**
 * 日记与评论。
 *
 * 与广播相反：**长文可以编辑**，所以多条修订是正常的，正是要留住的东西。而这一点
 * 也让它比广播危险 —— 抽取器一不稳，产出的就是凭空捏造的编辑历史，且不会报错。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { extractLongform } from '../src/extract-longform.js';
import { openAll } from '../src/bundle-source.js';
import { parse } from '../src/parse.js';

const notePage = (id, body, footer = `1740人浏览`) => `<html><body>
  <div id="note-${id}" class="note-container" data-url="https://www.douban.com/note/${id}/" data-author="MewX">
    <h1>标题在这</h1>
    <span class="pub-date">2025-04-14 18:47:50 澳大利亚</span>
    <div class="note" id="note_${id}_short" style="display:none;"></div>
    <div id="note_${id}_full"><div id="link-report"><div class="note">${body}</div></div></div>
    <div id="note_${id}_footer">${footer}</div>
  </div></body></html>`;

describe('日记', () => {
  test('抽出标题、秒级时间、发布地、全文', () => {
    const r = extractLongform(notePage('872015292', '<p data-page="0">正文第一段</p>'), 'note');
    assert.equal(r.id, '872015292');
    assert.equal(r.title, '标题在这');
    assert.equal(r.publishedAt, '2025-04-14 18:47:50');
    assert.equal(r.location, '澳大利亚');
    assert.match(r.body, /正文第一段/);
  });

  test('**正文右端必须钉死 —— 否则浏览计数会变成编辑历史**', () => {
    // 第一版没钉右端，溢出到页脚吞了「1740人浏览」。那个数每次抓取都在涨，于是同一
    // 篇日记在三次抓取里产出了三条修订，看起来像用户在 24 小时内改了两次。
    //
    // 这是这套系统最坏的一种错：凭空捏造编辑历史，而且不会报错。
    const a = extractLongform(notePage('1', '<p data-page="0">同一篇</p>', '1740人浏览'), 'note');
    const b = extractLongform(notePage('1', '<p data-page="0">同一篇</p>', '1741人浏览'), 'note');
    assert.equal(a.body, b.body, '正文里混进了页脚的浏览计数');
    assert.ok(!/人浏览/.test(a.body));
  });

  test('不抓 _short —— 那是列表页的摘要，正文页上是空的', () => {
    const r = extractLongform(notePage('2', '<p data-page="0">全文内容</p>'), 'note');
    assert.equal(r.body, '全文内容');
  });

  test('认不出来就返回 null，不猜', () => {
    assert.equal(extractLongform('<html><body>被拦了</body></html>', 'note'), null);
  });
});

describe('评论', () => {
  const reviewPage = (id) => `<html><body>
    <h1><span property="v:summary">评论标题</span></h1>
    <span class="main-title-hide">4</span>
    <div class="main-meta"><span content="2017-02-24">2017-02-24 16:15:24</span></div>
    <script type="application/ld+json">{"itemReviewed":{"url":"/subject/26425271/",
      "sameAs":"https://www.douban.com/game/26425271/"}}</script>
    <div class="main-bd" id="review-${id}-content"><div id="link-report-${id}">
      <div class="review-content" data-url="https://www.douban.com/review/${id}/">正文<br><br>第二段</div>
    </div></div><style>x</style></body></html>`;

  test('标题在 v:summary 里，不是 h1 的直接文字', () => {
    // **原始抓取的 HTML 与浏览器另存的不一样**：后者跑过 JS，h1 里已经是纯文字。
    // 照浏览器那份写选择器，会在真实数据上落空。
    const r = extractLongform(reviewPage('8381069'), 'review');
    assert.equal(r.title, '评论标题');
    assert.equal(r.rating, 4);
    assert.equal(r.publishedAt, '2017-02-24 16:15:24');
  });

  test('**关联作品取 sameAs，不取 url**', () => {
    // JSON-LD 里的 url 是相对路径 `/subject/26425271/`，而这条评论其实是给**游戏**
    // 写的（`/game/26425271/`）。取相对路径会把媒介弄错。
    const r = extractLongform(reviewPage('8381069'), 'review');
    assert.equal(r.subjectUrl, 'https://www.douban.com/game/26425271/');
  });

  test('正文保留换行', () => {
    assert.match(extractLongform(reviewPage('1'), 'review').body, /正文\n\n第二段/);
  });
});

describe('对着真实档案', () => {
  const DL = '/home/mewx/downloads/20260806';

  test('**4 篇长文，每篇都只有 1 条修订** —— 抽取器是稳的', (t) => {
    if (!existsSync(DL)) return t.skip('真实档案不在这台机器上');
    const { longform } = parse(openAll(DL));
    assert.equal(longform.length, 4);
    for (const r of longform) {
      assert.equal(r.revisions.length, 1,
        `${r.kind} ${r.upstream_id} 有 ${r.revisions.length} 条修订——多半是抽取器不稳，不是用户改了`);
      // 每篇都被抓了 3 次。要是只被抓过 1 次，上面那条断言就是空的。
      assert.equal(r.revisions[0].observations.length, 3);
      assert.ok((r.revisions[0].fields.body ?? '').length > 200, '正文太短，像是只抽到了摘要');
    }
  });

  test('那篇讲被删电影的日记，全文在档案里', (t) => {
    if (!existsSync(DL)) return t.skip('真实档案不在这台机器上');
    const { longform } = parse(openAll(DL));
    const note = longform.find((r) => r.upstream_id === '868128497');
    assert.equal(note.revisions[0].fields.title, '想看的被河蟹的电影');
    assert.match(note.revisions[0].fields.body, /An Unfinished Film/);
  });
});
