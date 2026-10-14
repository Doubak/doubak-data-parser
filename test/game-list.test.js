import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMarks } from '../src/extract.js';

// 20261011T113553Z-6dd948#000044 的 common-item 结构，内容已替换；
// 操作栏可被删除或插入访问者评分，以模拟公开页面差异，不冒充真实跨账号样本。
const item = ({ rating = 4, comment = '好', operations = '' } = {}) => `<div class="common-item">
  <div class="pic"><a href="https://www.douban.com/game/123/"><img src="https://img1.doubanio.com/lpic/s1.jpg"></a></div>
  <div class="content"><div class="title"><a href="https://www.douban.com/game/123/">游戏</a></div>
  <div class="desc">PC / 角色扮演<div class="rating-info">
    ${rating == null ? '' : `<span class="rating-star allstar${rating}0"></span>`}
    <span class="date">2026-10-01</span></div></div>
  ${comment == null ? '' : `<div>${comment}</div>`}${operations}</div></div>`;

test('游戏公开列表无修改按钮仍保留目标的评分、单字短评', () => {
  const [mark] = extractMarks(item(), 'game').marks;
  assert.equal(mark.rating, 4);
  assert.equal(mark.comment, '好');
});

test('目标评分与访问者操作控件冲突时只读正文星级', () => {
  const [mark] = extractMarks(item({ operations: '<div class="user-operation"><a data-rating="1">收藏</a></div>' }), 'game').marks;
  assert.equal(mark.rating, 4);
});

test('末项缺失评分和短评时，不从条目外的访问者表单、推荐区补值', () => {
  const html = item({ rating: null, comment: null })
    + '<div><div class="rating-info"><span class="rating-star allstar50"></span></div><div>访问者短评</div><a data-rating="5">修改</a></div>';
  const [mark] = extractMarks(html, 'game').marks;
  assert.equal(mark.rating, null);
  assert.equal(mark.comment, null);
});

test('条目闭合不完整时不把页尾当标记正文', () => {
  assert.equal(extractMarks(item().slice(0, -6), 'game').marks.length, 0);
});
