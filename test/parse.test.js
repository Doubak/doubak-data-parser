/**
 * 解析器：bundle → canonical。
 *
 * 规范在 doubak-data-specs/canonical/。这里守的是那些**违反了也不会报错、只会
 * 悄悄产出错数据**的规则——那是这个项目一贯的失败形状。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { absenceAuthority, isContent, hasUnknownVerdict } from '../src/authority.js';
import { fieldDigest, digestAll, sameRevision } from '../src/digest.js';
import { extractMarks } from '../src/extract.js';
import { openAll } from '../src/bundle-source.js';
import { parse } from '../src/parse.js';

describe('缺失推断的权限', () => {
  const clean = { contiguous: true, gaps: [], enumeration: 'full' };

  test('full + 连续 + 无缺口 + 收尾 → 整条路线都能推断删除', () => {
    assert.equal(absenceAuthority(clean, 'complete'), 'whole_route');
  });

  test('**增量抓取天然只能推断下界之上**', () => {
    // 它读到下界就停，下界以下这次压根没看。
    const inc = { contiguous: true, gaps: [], enumeration: 'bounded', floor_time: '2026-08-01T00:00:00+08:00' };
    assert.equal(absenceAuthority(inc, 'complete'), 'above_floor');
  });

  test('bounded 但没有下界 → none', () => {
    // 说不出「以下」是哪儿，就没有任何区间可以声称看全了。
    assert.equal(absenceAuthority({ ...clean, enumeration: 'bounded' }, 'complete'), 'none');
  });

  test('**一处缺口就降到 none**，不是「缺口那一段不算」', () => {
    // 缺口意味着我们不知道漏了什么，而漏掉的东西完全可能正好在别处。
    assert.equal(absenceAuthority({ ...clean, gaps: [{ reason: 'blocked' }] }, 'complete'), 'none');
    assert.equal(absenceAuthority({ ...clean, contiguous: false }, 'complete'), 'none');
  });

  test('没收尾的档案 → none（但它的数据照样要读）', () => {
    assert.equal(absenceAuthority(clean, 'aborted'), 'none');
    assert.equal(absenceAuthority(clean, 'in_progress'), 'none');
  });

  test('**没有 crawl_state → none，默认必须是保守的**', () => {
    assert.equal(absenceAuthority(undefined, 'complete'), 'none');
  });
});

describe('哪些捕获能当内容读', () => {
  test('只有 verdict=ok', () => {
    assert.equal(isContent({ verdict: 'ok' }), true);
    for (const v of ['blocked', 'challenge', 'login', 'gone', 'soft404']) {
      assert.equal(isContent({ verdict: v }), false, v);
    }
  });

  test('**login 尤其不行 —— 它长得像好数据**', () => {
    // 实测：2023-01 那批 105 张电影页全是匿名抓的，条目 1554 条一条不少，
    // 而标签 0 个（前后两批是 945 和 1051），游戏评分同样整批消失。
    // 当内容读会得出「用户删光了标签又加回来」——四万条假编辑。
    assert.equal(isContent({ verdict: 'login' }), false);
  });

  test('未知的 verdict 当作判不出来，不当作 ok', () => {
    // 封闭词表出现新取值 = 生产者知道一种本解析器不认识的失败方式。
    assert.equal(hasUnknownVerdict({ verdict: 'quarantined' }), true);
    assert.equal(hasUnknownVerdict({ verdict: 'ok' }), false);
  });
});

describe('摘要', () => {
  test('NFC、去尾空白、统一换行', () => {
    assert.equal(fieldDigest('a\r\nb  '), fieldDigest('a\nb'));
    assert.equal(fieldDigest('Å'), fieldDigest('Å'));
  });

  test('**绝不折叠简繁与大小写 —— 那些是真实的编辑**', () => {
    assert.notEqual(fieldDigest('臺灣'), fieldDigest('台湾'));
    assert.notEqual(fieldDigest('Alien'), fieldDigest('alien'));
  });

  test('null 就是 null，不是空串的摘要', () => {
    // 「页面上确实没有」与「页面上有但是空的」是两件事。
    assert.equal(fieldDigest(null), null);
    assert.notEqual(fieldDigest(''), null);
  });

  test('键序不影响摘要', () => {
    assert.equal(fieldDigest({ a: 1, b: 2 }), fieldDigest({ b: 2, a: 1 }));
  });

  test('**逐字段算，不是整条算一个**', () => {
    // 否则改一次评分会让短评也看起来被重写过。
    const a = digestAll({ rating: 4, comment: '好看' });
    const b = digestAll({ rating: 5, comment: '好看' });
    assert.notEqual(a.rating, b.rating);
    assert.equal(a.comment, b.comment, '短评没动，摘要不该变');
    assert.equal(sameRevision(a, b), false);
  });
});

describe('抽取：每种媒介一套选择器', () => {
  test('电影：评分在 class 上', () => {
    const html = `<div class="item comment-item" data-cid="123">
      <a href="https://movie.douban.com/subject/1292052/"><img src="https://img1.doubanio.com/x.jpg"></a>
      <li class="title"><a><em>肖申克的救赎</em></a></li>
      <span class="rating4-t"></span><span class="date">2026-07-19</span>
      <span class="tags">标签: 经典 美国</span>
      <span class="comment">很好看</span><a rel="1292052:P"></a></div>`;
    const { marks } = extractMarks(html, 'movie');
    assert.equal(marks.length, 1);
    assert.deepEqual(
      { id: marks[0].subjectId, up: marks[0].upstreamId, r: marks[0].rating, t: marks[0].tags, rel: marks[0].relStatus },
      { id: '1292052', up: '123', r: 4, t: ['经典', '美国'], rel: 'done' },
    );
  });

  test('**游戏：评分在 data-rating，短评在裸 div，id 在删除按钮上**', () => {
    // 用电影那套选择器量游戏，会得出「0% 有评分、0% 有短评」——而真值是 51% 与 72%。
    const html = `<div class="common-item">
      <div class="pic"><a href="https://www.douban.com/game/36092279/"><img src="https://img2.doubanio.com/lpic/s1.jpg"></a></div>
      <div class="content"><div class="title"><a href="x">莱莎的炼金工房3</a></div>
      <div class="desc">PC / PS5 / 角色扮演
        <div class="rating-info"><span class="rating-star allstar30"></span>
        <span class="date">2026-07-19</span><span class="tags">标签: RPG 日本</span></div>
      </div>
      <div>3年下来，还是决定弃坑啦。</div>
      <div class="user-operation"><a class="collect-btn" data-rating="3">修改</a>
      <a class="js-remove-collect" data-url="/j/ilmen/thing/36092279/interest">删除</a></div>
      </div></div>`;
    const { marks } = extractMarks(html, 'game');
    assert.equal(marks.length, 1);
    assert.equal(marks[0].rating, 3);
    assert.match(marks[0].comment, /还是决定弃坑啦/);
    assert.equal(marks[0].upstreamId, '36092279');
  });

  test('**短评里贴的链接不会挤进来**', () => {
    // 条目自己的链接总在最前面。实测一条真实的书标记短评里贴了电影链接。
    const html = `<li class="subject-item"><div class="pic">
      <a href="https://book.douban.com/subject/27141473/"><img src="https://img1.doubanio.com/x.jpg"></a></div>
      <span class="date">2026-07-31</span>
      <p class="comment comment-item">为什么电影条目被删了？？？https://movie.douban.com/subject/11611021/</p></li>`;
    const { marks } = extractMarks(html, 'book');
    assert.equal(marks.length, 1);
    assert.equal(marks[0].subjectId, '27141473');
  });

  test('有时间却抽不到 id → 计进 idless，好报警', () => {
    const html = '<div class="item comment-item"><span class="date">2026-01-01</span></div>';
    assert.equal(extractMarks(html, 'movie').idless, 1);
  });

  test('既没 id 也没时间的容器静静丢掉 —— 那是模板', () => {
    // 游戏页上有约 100 个 `<div class="item item-tags">` 是编辑表单的 JS 模板。
    const html = '<div class="item item-tags"><label for="tags">标签</label></div>';
    const r = extractMarks(html, 'movie');
    assert.equal(r.containers, 1);
    assert.equal(r.idless, 0);
    assert.equal(r.marks.length, 0);
  });
});

describe('墓碑：作品被删，标记还在', () => {
  const withImg = (src, extra) => `<div class="item comment-item">
    <a href="https://movie.douban.com/subject/1/"><img src="${src}"></a>
    <span class="date">2026-01-01</span>${extra}</div>`;

  test('**只看占位图会误判 14 条只是没海报的作品**', () => {
    // 实测 2933 条里：占位图 + 非墓碑 = 14 条。所以占位图单独不能作判据。
    assert.equal(extractMarks(withImg('https://img1.doubanio.com/cuphead/x.png', ''), 'movie').marks[0].upstreamDeleted, false);
  });

  test('**只看「没有链接」会漏掉全部电影墓碑** —— 它们的链接还在', () => {
    const html = withImg('https://img1.doubanio.com/cuphead/movie_default.png', '<em>未知电影</em>');
    assert.equal(extractMarks(html, 'movie').marks[0].upstreamDeleted, true);
  });

  test('正常条目不会被判成墓碑', () => {
    const html = withImg('https://img1.doubanio.com/view/photo/s_ratio_poster/public/p1.jpg', '<em>肖申克的救赎</em>');
    assert.equal(extractMarks(html, 'movie').marks[0].upstreamDeleted, false);
  });
});

describe('对着真实档案端到端', () => {
  const DL = '/home/mewx/downloads/20260806';

  test('五份成链档案 → 数字与实测吻合', (t) => {
    if (!existsSync(DL)) return t.skip('真实档案不在这台机器上');
    const { marks, subjects, warnings } = parse(openAll(DL));

    const byMedium = {};
    for (const m of marks) byMedium[m.medium] = (byMedium[m.medium] ?? 0) + 1;
    assert.deepEqual(byMedium, { movie: 2102, book: 145, music: 84, game: 604, drama: 5 });

    // **标记的修订只应来自用户的编辑。** 实测五份档案跨越的时间里恰好有三次真实的
    // 状态迁移（想看→看过 ×2、想看→在看 ×1），除此之外一条都不该有。
    const multi = marks.filter((m) => m.revisions.length > 1);
    assert.equal(multi.length, 3, `多出来的修订：${multi.map((m) => m.subject.id).join(' ')}`);
    for (const m of multi) {
      assert.equal(m.revisions[0].fields.status, 'wish');
      assert.notEqual(m.revisions[1].fields.status, 'wish');
    }

    // 墓碑：电影 1 + 游戏 7。作品名必须是 null——「未知电影」是占位符不是标题。
    assert.equal(marks.filter((m) => m.subject.upstream_deleted).length, 8);
    const tombs = subjects.filter((s) => s.upstream_deleted);
    assert.equal(tombs.length, 8);
    assert.ok(tombs.every((s) => s.revisions.every((r) => r.fields.title === null)));

    assert.deepEqual(warnings, [], '真实档案上不该有任何告警');
  });

  test('**追加是纯增的** —— 多喂一份档案不会丢掉任何东西', (t) => {
    if (!existsSync(DL)) return t.skip('真实档案不在这台机器上');
    // canonical/INGESTION.md §5.1。做成对全集的纯函数，这条性质是免费的；
    // 做成「在上次结果上打补丁」，它就要靠小心维护。
    const all = openAll(DL);
    const few = parse(all.slice(0, 3)).marks;
    const more = parse(all).marks;

    const key = (m) => `${m.medium}:${m.subject.id}`;
    const fewKeys = new Set(few.map(key));
    const moreKeys = new Set(more.map(key));
    for (const k of fewKeys) assert.ok(moreKeys.has(k), `多喂档案之后丢了 ${k}`);
    assert.ok(more.length >= few.length);
  });

  test('顺序无关', (t) => {
    if (!existsSync(DL)) return t.skip('真实档案不在这台机器上');
    const a = parse(openAll(DL)).marks.length;
    const b = parse(openAll(DL).reverse()).marks.length;
    assert.equal(a, b);
  });
});
