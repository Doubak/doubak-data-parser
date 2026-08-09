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

  test('**`<script>` 的内容不许进正文** —— 那里面有豆瓣前端的资源哈希', () => {
    // 剥标签的正则只吃 `<...>`，留下的是标签之间的东西——而 `<script>` 之间的
    // 东西是 JS 源码。实测两篇日记因此带上了：
    //
    //     Do.add('html5_video', { path: '…/note/html5_video.48d02.js' })
    //
    // 那串 `48d02` 是豆瓣前端资源的哈希，**豆瓣重新发布一次前端它就变一次**，
    // 于是一个字没动的日记会凭空多出一条修订。与浏览计数是同一类错。
    const js = (h) => `<script>Do.add('html5_video', {path: '…/html5_video.${h}.js'})</script>`;
    const a = extractLongform(notePage('1', `<p data-page="0">一字未改</p>${js('48d02')}`), 'note');
    const b = extractLongform(notePage('1', `<p data-page="0">一字未改</p>${js('9f3c1')}`), 'note');
    assert.equal(a.body, b.body, '正文里混进了 script 的内容');
    assert.ok(!/html5_video|Do\.add/.test(a.body));
    assert.equal(a.body, '一字未改');
  });

  test('不抓 _short —— 那是列表页的摘要，正文页上是空的', () => {
    const r = extractLongform(notePage('2', '<p data-page="0">全文内容</p>'), 'note');
    assert.equal(r.body, '全文内容');
  });

  test('认不出来就返回 null，不猜', () => {
    assert.equal(extractLongform('<html><body>被拦了</body></html>', 'note'), null);
  });

  test('**点列表要留成点列表**', () => {
    // 只剥标签的话五项会粘成一行，而且最后一项还会粘上后面那一段。实测那篇讲
    // 绑定手机号的日记变成了 `ck=JBf5old_phone=+86xxxxxxxxxxxarea_code=+86 …`
    // ——与「图注和下一段黏成一句」是同一个错：那已经不是用户写的字了，
    // 而且它不报错，只是读起来像乱码。
    const r = extractLongform(notePage('1', '<p data-page="0">前一段：</p>'
      + '<ul><li class="unordered-list-item">ck=JBf5</li>'
      + '<li class="unordered-list-item">area_code=+86</li></ul>'
      + '<p data-page="0">后一段。</p>'), 'note');
    assert.equal(r.body, '前一段：\n\n- ck=JBf5\n- area_code=+86\n\n后一段。');
  });

  test('列表项之间不空行 —— 空行会变成「松散列表」，行距大一倍', () => {
    const r = extractLongform(notePage('1', '<ul><li>甲</li><li>乙</li></ul>'), 'note');
    assert.equal(r.body, '- 甲\n- 乙');
  });

  test('**段与段之间要空一行**，否则 CommonMark 把它当段内软换行', () => {
    // 只给一个 `\n` 的话，渲染出来是一个空格——实测那篇日记的三段在页面上并成了
    // 一整段。
    const r = extractLongform(notePage('1', '<p data-page="0">第一段</p><p data-page="0">第二段</p>'), 'note');
    assert.equal(r.body, '第一段\n\n第二段');
  });

  test('**豆瓣的频道标签与版权声明不许进正文** —— 那不是用户写的字', () => {
    // `#link-report` 与页脚之间还夹着 div.mod-tags（频道标签）、投诉按钮、
    // div.copyright-claim。不收紧的话正文末尾会挂上「科技 / 生活 /
    // 本文版权归 X 所有…」。与「未知作品」「1740人浏览」同一条规则：
    // 页面装潢不是内容。
    const page = `<html><body>
      <div id="note-1" class="note-container" data-url="https://www.douban.com/note/1/">
        <h1>标题在这</h1><span class="pub-date">2025-04-14 18:47:50 澳大利亚</span>
        <div id="link-report">
          <div class="note"><p data-page="0">这是我写的</p></div>
          <div class="mod-tags"><a href="#">科技</a><a href="#">生活</a></div>
          <div class="copyright-claim original"><p>本文版权归 MewX 所有，任何形式转载请联系作者。</p></div>
        </div>
        <div id="note_1_footer">1740人浏览</div>
      </div></body></html>`;
    const r = extractLongform(page, 'note');
    assert.equal(r.body, '这是我写的');
  });

  test('**认不出 `div.note` 就退回整段，绝不返回 null**', () => {
    // 手上只有 2 篇 `/note/` 带这个容器。n=2 推不出封闭的形状集合——这个项目
    // 已经在这上面栽过四次。多几行页面装潢是难看，丢掉整篇正文是灾难。
    const page = `<html><body>
      <div id="note-1" data-url="https://www.douban.com/note/1/">
        <h1>标题在这</h1><span class="pub-date">2025-04-14 18:47:50 澳大利亚</span>
        <div id="link-report"><p data-page="0">换了个容器的正文</p></div>
        <div id="note_1_footer">1740人浏览</div>
      </div></body></html>`;
    assert.equal(extractLongform(page, 'note').body, '换了个容器的正文');
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
    // 同样不钉死篇数——它会随着新写的日记长大。要守的是「每篇只有一条修订」。
    assert.ok(longform.length >= 4, `只有 ${longform.length} 篇`);
    // **「只有一条修订」这句话不能是空的。** 刚发的日记只被抓过一次，对它而言那句话
    // 无从证伪；所以要求整组里**至少有一篇**被观测过多次——那一篇才真正证明了
    // 抽取器跨抓取是稳的。（原来对每一篇都要求 ≥2 次，用户新发一篇日记就红了。）
    assert.ok(
      longform.some((r) => r.revisions[0].observations.length >= 2),
      '没有一篇被观测过多次，那「只有一条修订」就是空话',
    );
    for (const r of longform) {
      assert.equal(r.revisions.length, 1,
        `${r.kind} ${r.upstream_id} 有 ${r.revisions.length} 条修订——多半是抽取器不稳，不是用户改了`);
      assert.ok((r.revisions[0].fields.body ?? '').length > 100, '正文太短，像是只抽到了摘要');
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

describe('/topic/ 那种日记', () => {
  /**
   * 日记有两种页面结构，**不是豆瓣改版**——两种同时存在，发日记时用哪个编辑器就
   * 得到哪一种。写第一版时手上只有两篇、恰好都是旧那种，于是从 n=2 推出了一个
   * 封闭集合。抓取那边犯过同样的错。
   */
  const PAGE = '/home/mewx/downloads/496284296.html';
  const topic = (body, views = 4) => `<html><body>
    <link rel="canonical" href="https://www.douban.com/topic/496284296/">
    <h1 class="topic-title">测试一下带图的日记</h1>
    <div class="personal-topic" id="topic-content">
      <div class="topic-meta">
        <span class="create-time">2026-08-07 16:25:36</span>
        <span class="ip-location">澳大利亚</span>
        <span class="create-visit-count">${views}浏览</span>
      </div>
      <div class="topic-content"><div class="rich-content topic-richtext">${body}</div></div>
    </div></body></html>`;

  test('抽出标题、秒级时间、发布地、全文', () => {
    const r = extractLongform(topic('<p>正文</p>'), 'note');
    assert.equal(r.id, '496284296');
    assert.equal(r.title, '测试一下带图的日记');
    assert.equal(r.publishedAt, '2026-08-07 16:25:36');
    assert.equal(r.location, '澳大利亚');
    assert.equal(r.body, '正文');
  });

  test('**正文里嵌着 div 也要抽全** —— 图片就是 div', () => {
    // `([\s\S]*?)</div>` 会停在第一个闭合标签上：实测那篇带图日记只抽到 32 个字，
    // 剩下两段全丢了。所以要数嵌套，不能靠正则。
    const body = '<p>第一段</p>'
      + '<div class="image-container"><div class="image-wrapper"><img src="x"></div></div>'
      + '<p>第二段</p>';
    assert.match(extractLongform(topic(body), 'note').body, /第一段[\s\S]*第二段/);
  });

  test('**浏览计数不许进正文** —— 它每次抓取都在涨', () => {
    // 吞进去的话，同一篇日记每抓一次就多一条修订，也就是凭空捏造编辑历史。
    const a = extractLongform(topic('<p>一字未改</p>', 4), 'note');
    const b = extractLongform(topic('<p>一字未改</p>', 5), 'note');
    assert.equal(a.body, b.body);
    assert.ok(!/浏览/.test(a.body));
  });

  test('图注不与下一段黏在一起', async () => {
    // 黏起来之后那已经不是用户写的字了。
    const body = '<div class="image-caption">图注</div><p>下一段</p>';
    assert.match(extractLongform(topic(body), 'note').body, /图注\n+下一段/);
  });

  test('对着真实页面：全文、无计数', async (t) => {
    const { existsSync, readFileSync } = await import('node:fs');
    if (!existsSync(PAGE)) return t.skip('样本不在这台机器上');
    const r = extractLongform(readFileSync(PAGE, 'utf-8'), 'note');
    assert.equal(r.id, '496284296');
    assert.equal(r.title, '测试一下带图的日记');
    assert.equal(r.publishedAt, '2026-08-07 16:25:36');
    assert.ok(r.body.length > 100, `正文只有 ${r.body.length} 字，像是被截断了`);
    assert.ok(!/\d+浏览/.test(r.body));
    assert.ok(!/Do\.add|doubanio\.com\/cuphead/.test(r.body), '正文里混进了豆瓣的前端脚本');
  });
});
