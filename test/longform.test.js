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
import { ARCHIVE_20260806, readCapture } from './real-archive.js';

const notePage = (id, body, footer = `1740人浏览`, {
  // 真实页面上这三样是分开的三处东西，所以夹具也分开：
  //   stat    页脚那个 `note-footer-stat` 容器（**在不在**，决定 public 还是 unknown）
  //   privacy 容器里那一行「此日记锁定仅自己可见」
  //   censor  豆瓣自己那条通告（**只有它能证明是豆瓣锁的**）
  stat = true, privacy = false, censor = false,
} = {}) => `<html><body>
  ${censor ? `<div class="notice-info notice-info-type-4"><div class="notice-info-texts">
    <p class="notice-info-text"><i class="notice-info-icon "></i>
    含有违规或引发不良讨论的内容，内容仅自己可见，请勿发布同类信息 </p></div></div>` : ''}
  <div id="note-${id}" class="note-container" data-url="https://www.douban.com/note/${id}/" data-author="MewX">
    <h1>标题在这</h1>
    <span class="pub-date">2025-04-14 18:47:50 澳大利亚</span>
    <div class="note" id="note_${id}_short" style="display:none;"></div>
    <div id="note_${id}_full"><div id="link-report"><div class="note">${body}</div></div></div>
    <div id="note_${id}_footer">${stat ? `<div class="note-footer-stat">
      ${privacy ? '<div class="note-footer-stat-privacy"><span>此日记锁定仅自己可见</span></div>' : ''}
      <span class="note-footer-stat-modify">编辑 | 删除</span></div>` : ''}${footer}</div>
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
  const DL = ARCHIVE_20260806;

/**
 * 整份真实档案只解析一次，之后各条测试共用。
 *
 * **这不是省时间，是「测试跑不跑得起来」的问题。** 这些测试原来指着
 * `~/downloads/20260806`，档案归拢进 `exports/` 之后那条路径指空，于是它们
 * 从「跳过」变成**永远跳过**——一秒跑完，全绿，什么都没查。
 *
 * 路径修好之后它们真的跑了起来，而这个文件里有十几处各自 `parse(openAll(DL))`：
 * 26 份档案一次约 25 秒，一整趟五分多钟。**一套要跑五分钟的测试，与一套永远
 * 跳过的测试，在「有没有人跑它」这件事上是同一个结果。**
 *
 * 共用一份产出是安全的：`parse()` 是纯函数，而这些测试全都只读。**唯独
 * 「换个次序喂进去结果一样」那条不能共用**——它要的正是第二次解析。
 */
let _real;
const realParse = () => (_real ??= parse(openAll(DL)));

  test('**4 篇长文，每篇都只有 1 条修订** —— 抽取器是稳的', async (t) => {
    if (!existsSync(DL)) return t.skip('真实档案不在这台机器上');
    const { longform } = await realParse();
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

  test('那篇讲被删电影的日记，全文在档案里', async (t) => {
    if (!existsSync(DL)) return t.skip('真实档案不在这台机器上');
    const { longform } = await realParse();
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
  /**
   * 真实那一页**从档案里读**，不从 `~/downloads/` 下手工另存的散页读。
   *
   * 原来指的是 `~/downloads/496284296.html`，那个文件早没了，于是下面那条
   * 「对着真实页面」的测试**永远跳过**——而 npm test 照样全绿。档案是冻结的，
   * 这一页在里面跑不掉；顺带还证明了「它确实在档案里」。
   *
   * 这一份捕获是同一个网址在同一次抓取里的**第三次**：前两次判不出来（当时的
   * 抽取器还不认 topic 这套模板），第三次成了。见 parse.js 里
   * `recalibratableCovered` 那段。
   */
  const CAPTURE = ['doubak-bundle-20260807T083529Z-0fb09c', '20260807T083529Z-0fb09c#001564'];
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

  test('**浏览计数不许进正文** —— 它每次抓取都在涨', async () => {
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
    const page = await readCapture(...CAPTURE);
    if (!page) return t.skip('真实档案不在这台机器上');
    const r = extractLongform(page, 'note');
    assert.equal(r.id, '496284296');
    assert.equal(r.title, '测试一下带图的日记');
    assert.equal(r.publishedAt, '2026-08-07 16:25:36');
    assert.ok(r.body.length > 100, `正文只有 ${r.body.length} 字，像是被截断了`);
    assert.ok(!/\d+浏览/.test(r.body));
    assert.ok(!/Do\.add|doubanio\.com\/cuphead/.test(r.body), '正文里混进了豆瓣的前端脚本');
  });
});

/**
 * 「仅自己可见」有两个成因，方向相反。
 *
 * 实测档案里那篇《想看的被河蟹的电影》读作「仅自己可见」，而它**不是作者藏的**：
 * 页面上豆瓣自己写着「含有违规或引发不良讨论的内容……请勿发布同类信息」。
 *
 * 把两者合成一个布尔值，下游只有两种做法，两种都错：一律发出去，等于把作者藏起来
 * 的东西公开；一律藏起来，等于这份存档**替豆瓣把它二次消音**——而后者更隐蔽，
 * 一条被静默藏起来的记录不留任何痕迹给人发现。
 */
describe('可见性：豆瓣锁的，和作者藏的', () => {
  const topicPage = (body, { priv = false } = {}) => `<html><body>
    <link rel="canonical" href="https://www.douban.com/topic/499256241/">
    <h1 class="topic-title">标题在这</h1>
    <div class="personal-topic" id="topic-content">
      <div class="topic-meta">
        <span class="create-time">2026-09-07 16:56:22</span>
        <span class="ip-location">澳大利亚</span>
        ${priv ? '<i class="private-tag" title="仅自己可见"></i>' : ''}
      </div>
      <div class="topic-content"><div class="rich-content topic-richtext">${body}</div></div>
    </div></body></html>`;

  test('容器在、里面没标记 → public', () => {
    const r = extractLongform(notePage('1', '<p>正文</p>'), 'note');
    assert.equal(r.visibility, 'public');
    assert.equal(r.restrictedBy, null);
    assert.equal(r.restrictionNotice, null);
  });

  test('**豆瓣锁的 → platform，而且逐字留下豆瓣那句判词**', () => {
    // 那句话本身就是档案材料：它是豆瓣对用户自己写的东西下的评价，而豆瓣不会替谁
    // 保存它——与「分享了」被改成「转发了」是同一类上游史料。
    const r = extractLongform(
      notePage('2', '<p>正文</p>', '1740人浏览', { privacy: true, censor: true }), 'note');
    assert.equal(r.visibility, 'private');
    assert.equal(r.restrictedBy, 'platform');
    assert.equal(r.restrictionNotice,
      '含有违规或引发不良讨论的内容，内容仅自己可见，请勿发布同类信息');
  });

  test('作者自己设的 → author，没有判词', () => {
    const r = extractLongform(topicPage('<p>正文</p>', { priv: true }), 'note');
    assert.equal(r.visibility, 'private');
    assert.equal(r.restrictedBy, 'author');
    assert.equal(r.restrictionNotice, null);
  });

  test('**连隐私容器都找不到 → unknown，不是 public**', () => {
    // 豆瓣改一次 markup，所有私密日记就静默变成公开——而发出去的东西撤不回来。
    // 豆列那边（extractVisibility）早就写着同一条，这里是把它补到日记上。
    const r = extractLongform(notePage('3', '<p>正文</p>', '1740人浏览', { stat: false }), 'note');
    assert.equal(r.visibility, 'unknown');
    assert.equal(r.restrictedBy, null);
  });

  test('**判据是结构，不是「页面上有没有『仅自己可见』这几个字」**', () => {
    // 按文字认的话，正文里写着这几个字的日记会被判成私密——与广播那条
    // 「（全文）必须结构性地认，不能按文字认」是同一条规则。
    const r = extractLongform(
      notePage('4', '<p>我本来想把这篇设成仅自己可见的，后来没设。</p>'), 'note');
    assert.equal(r.visibility, 'public');
    assert.equal(r.restrictedBy, null);
  });

  test('**评论是 null，不是 unknown，也不是 public**', () => {
    // 与 `又名` 的 null（没读详情页）和 [] （读了，没有）同一条。实测 2 篇评论页上
    // 「私密」「仅自己」「可见」「公开」一个字都没有、连容器都不存在——那不是没读到，
    // 是豆瓣没给评论这个功能。写成 unknown 会让它们永远挂在「说不准」那一栏里，
    // 而一份永远有条目的名单是没人看的名单。
    const r = extractLongform(`<html><body><div class="article">
      <h1><span property="v:summary">评论标题</span></h1>
      <div class="main" id="8381069"><div class="main-meta"><span content="2017-02-24">2017-02-24 16:15:24</span></div>
      <div id="link-report-8381069"><p>正文</p></div></div></div><style></style></body></html>`, 'review');
    assert.equal(r.visibility, null);
    assert.equal(r.restrictedBy, null);
  });

  test('对着真实档案：那篇被豆瓣锁掉的日记', async (t) => {
    const page = await readCapture('doubak-bundle-20260806T131620Z-354a1d',
      '20260806T131620Z-354a1d#000013');
    if (!page) return t.skip('真实档案不在这台机器上');
    const r = extractLongform(page, 'note');
    assert.equal(r.title, '想看的被河蟹的电影');
    assert.equal(r.visibility, 'private');
    assert.equal(r.restrictedBy, 'platform');
    assert.match(r.restrictionNotice, /含有违规/);
  });

  test('对着真实档案：那篇作者自己设成私密的日记', async (t) => {
    const page = await readCapture('doubak-bundle-20260907T085647Z-8ffd98',
      '20260907T085647Z-8ffd98#000010');
    if (!page) return t.skip('真实档案不在这台机器上');
    const r = extractLongform(page, 'note');
    assert.equal(r.title, '测试一下私密日记？');
    assert.equal(r.visibility, 'private');
    // **这一篇与上一篇是这条规则的两个端点。** 少了任何一个，「分开」就无从证明。
    assert.equal(r.restrictedBy, 'author');
    assert.equal(r.restrictionNotice, null);
  });
});

/**
 * 认不出隐私容器时留下的线索。
 *
 * `unknown` 的处置是「当私密处理」——安全，但也因此**安静**：站点少发一页、导出收成
 * 「仅提及者可见」，两边都不报错。而成因几乎只有一个，就是豆瓣改了 markup。那一页
 * 已经如实躺在档案里，改好抽取器重跑就救得回来——**前提是有人知道该去改哪儿**。
 */
describe('认不出来的时候，留下线索', () => {
  const noContainer = (extra = '') => `<html><body>
    <div id="note-9" class="note-container" data-url="https://www.douban.com/note/9/">
      <h1>标题</h1>
      <span class="pub-date">2025-04-14 18:47:50 澳大利亚</span>
      <div id="note_9_full"><div id="link-report"><div class="note"><p>正文</p></div></div></div>
      ${extra}
      <div id="note_9_footer">1740人浏览</div>
    </div></body></html>`;

  test('**认不出来时带上找过哪两个容器**', () => {
    const r = extractLongform(noContainer(), 'note');
    assert.equal(r.visibility, 'unknown');
    assert.deepEqual(r.visibilityHint.tried, ['div.topic-meta', 'div.note-footer-stat']);
  });

  test('**把这一页上长得像隐私标记的类名捞出来** —— 豆瓣改的名字通常就在里面', () => {
    const r = extractLongform(noContainer(
      '<div class="note-visibility-badge is-private-v2">仅自己可见</div>'), 'note');
    assert.deepEqual(r.visibilityHint.sawClasses, ['is-private-v2', 'note-visibility-badge']);
  });

  test('**一个字的正文都不许进线索** —— 告警是会被贴进 issue 的', () => {
    const r = extractLongform(noContainer(), 'note');
    const dumped = JSON.stringify(r.visibilityHint);
    assert.ok(!dumped.includes('正文'), '正文漏进告警了');
    assert.ok(!dumped.includes('标题'), '标题漏进告警了');
  });

  test('类名去重、排序、封顶 8 个 —— 刷屏的告警没人看', () => {
    const many = Array.from({ length: 20 }, (_, i) => `<i class="private-${i} private-${i}"></i>`).join('');
    const r = extractLongform(noContainer(many), 'note');
    assert.equal(r.visibilityHint.sawClasses.length, 8);
    assert.deepEqual(r.visibilityHint.sawClasses, [...new Set(r.visibilityHint.sawClasses)]);
  });

  test('认得出来的时候**不带**线索 —— 那是给改抽取器的人看的，不是记录的事实', () => {
    for (const html of [notePage('1', '<p>正文</p>'),
      notePage('2', '<p>正文</p>', '1740人浏览', { privacy: true, censor: true })]) {
      assert.equal(extractLongform(html, 'note').visibilityHint, undefined);
    }
  });

  test('线索**不进 canonical** —— 它不是这条记录的事实', async () => {
    const { parse: doParse } = await import('../src/parse.js');
    const { longform } = await doParse([{
      status: 'complete', manifest: null, bundleId: 'aaaaaa',
      index: [{
        capture_id: 'aaaaaa#000001', route_key: 'note.item', intent: 'note.item',
        url: 'https://www.douban.com/note/9/', verdict: 'ok', surface: 'html',
      }],
      crawlState: new Map(), coverage: new Map(),
      payload: async () => noContainer(),
      close: () => {},
    }]);
    const fields = longform[0].revisions[0].fields;
    assert.equal(fields.visibility, 'unknown');
    assert.ok(!('visibilityHint' in fields), '线索漏进 canonical 了——它会进摘要，然后凭空造修订');
  });

  test('**告警要真的报出来，还要带得上网址与 capture_id**', async () => {
    const { parse: doParse } = await import('../src/parse.js');
    const { warnings } = await doParse([{
      status: 'complete', manifest: null, bundleId: 'aaaaaa',
      index: [{
        capture_id: 'aaaaaa#000001', route_key: 'note.item', intent: 'note.item',
        url: 'https://www.douban.com/note/9/', verdict: 'ok', surface: 'html',
      }],
      crawlState: new Map(), coverage: new Map(),
      payload: async () => noContainer('<div class="brand-new-privacy-thing"></div>'),
      close: () => {},
    }]);
    const w = warnings.find((x) => x.kind === 'note_visibility');
    assert.ok(w, '一条告警都没报——那这件事就是静默的');
    assert.equal(w.type, 'extractor_stale');
    assert.equal(w.capture, 'aaaaaa#000001');
    assert.equal(w.url, 'https://www.douban.com/note/9/');
    assert.deepEqual(w.sawClasses, ['brand-new-privacy-thing']);
  });

  test('**认得出来的页面一条告警都不报** —— 常驻告警等于没有告警', async () => {
    const { parse: doParse } = await import('../src/parse.js');
    const { warnings } = await doParse([{
      status: 'complete', manifest: null, bundleId: 'aaaaaa',
      index: [{
        capture_id: 'aaaaaa#000001', route_key: 'note.item', intent: 'note.item',
        url: 'https://www.douban.com/note/1/', verdict: 'ok', surface: 'html',
      }],
      crawlState: new Map(), coverage: new Map(),
      payload: async () => notePage('1', '<p>正文</p>'),
      close: () => {},
    }]);
    assert.deepEqual(warnings.filter((x) => x.kind === 'note_visibility'), []);
  });
});
