/**
 * 广播。
 *
 * 与标记正好相反的一条性质：**广播发布后不可编辑**。所以一条广播有多于一条修订，
 * 不是「用户改了」，是抽取器或页面变了——那是要去看的，不是要接受的。
 *
 * 这也是这条路线排最优先的理由：每条广播是「那一刻这句话是什么样」的带日期快照，
 * 而那是**首次抓取之前发生的编辑**唯一可能的证据来源。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { extractBroadcasts } from '../src/extract-broadcast.js';
import { openAll } from '../src/bundle-source.js';
import { parse } from '../src/parse.js';
import { ARCHIVE_20260806 } from './real-archive.js';

const OWNER = '82160871';
/**
 * 一条广播的容器。
 *
 * **`inner` 前面那个 `<div class="text">` 不是装饰。** 真实页面上，人名与动作句
 * 装在 `.text` 里，时间戳、卡片、附图都在它外面——动作句的右边界正是这个 `</div>`
 * （或者更早出现的 `<blockquote>`）。实测 21754 条广播里，时间戳落进动作句范围内的
 * **0 条**。
 *
 * 第一版夹具没有这一层，于是「动作句」一路吃到时间戳，把 `x` 也算了进去。
 * 那不是抽取器的毛病，是**夹具不长得像豆瓣**——而夹具一旦比真实页面宽松，
 * 它就只能证明代码在一种现实中不存在的输入上的行为。
 */
const wrap = (uid, inner, { text = true } = {}) =>
  `<div class="new-status status-wrapper" data-sid="900${uid}" data-uid="${uid}">`
  + (text ? `<div class="text">${inner}</div>` : inner)
  + '</div>';

describe('抽取', () => {
  test('身份走 data-sid，时间到秒', () => {
    const html = wrap(OWNER, '<a class="lnk-people">MewX</a> 想看')
      .replace('</div></div>', '</div>'
        + '<span class="created_at" title="2026-07-18 12:44:56">x</span>'
        + '<blockquote><p>能上6分我觉得都是国产好片</p></blockquote>'
        + '<div data-target-type="movie" data-object-id="36838707"></div></div>');
    const { broadcasts } = extractBroadcasts(html, OWNER);
    assert.equal(broadcasts.length, 1);
    const b = broadcasts[0];
    assert.equal(b.sid, `900${OWNER}`);
    // **比标记页精确**：那边只到天。合并同一条记录的观测时不得用低精度覆盖它。
    assert.equal(b.postedAt, '2026-07-18 12:44:56');
    assert.equal(b.status, 'wish');
    assert.equal(b.targetId, '36838707');
    assert.match(b.text, /国产好片/);
  });

  test('**打了分的广播，正文也要抽到** —— 评分星夹在 blockquote 与 <p> 之间', () => {
    // 这是真实页面的形状：带评分的广播在 `<blockquote>` 与正文 `<p>` 之间还夹着
    // 一个评分星。原来那条正则要求两者紧挨着（`<blockquote>\s*<p>`），于是
    // **凡是打了分的广播，正文一律抽不到**。
    //
    // 实测这份档案：2200 条有正文的广播漏掉 1411 条（64%），而漏掉的那 1411 条
    // **每一条**都带评分——不是零星漏网，是一整类。
    //
    // 它一句告警都没有：`text: null` 与「这条本来就没写字」长得一模一样，而后者
    // 本来就占多数（纯标记动作），所以连数字上都看不出异常。
    const html = wrap(OWNER, `<a class="lnk-people">MewX</a> 玩过
      <span class="created_at" title="2026-08-09 18:18:13">x</span>
      <blockquote>
        <span class="rating-stars">&#9733;&#9733;&#9733;&#9733;&#9733;</span>
        <p>前几周全金牌了，太喜欢这个游戏了</p>
      </blockquote>
      <div data-target-type="game" data-object-id="37294205"></div>`);
    const { broadcasts } = extractBroadcasts(html, OWNER);
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].text, '前几周全金牌了，太喜欢这个游戏了');
    // 评分星是豆瓣画的，不是用户写的字，不许混进正文。
    assert.ok(!/★|9733/.test(broadcasts[0].text));
  });

  test('**转发进来的是别人的，不许存**', () => {
    // 转发不是嵌套结构：豆瓣把原作者那条整个渲染成一个顶层 wrapper，data-uid 是原作者。
    const html = wrap(OWNER, '<span class="created_at" title="2026-01-01 00:00:00">x</span>')
      + wrap('1155157', '<span class="created_at" title="2026-01-02 00:00:00">x</span>');
    const r = extractBroadcasts(html, OWNER);
    assert.equal(r.broadcasts.length, 1);
    assert.equal(r.skippedOthers, 1);
  });

  test('拿不到主人是谁就直接拒绝', () => {
    assert.throws(() => extractBroadcasts('<div></div>', ''), /ownerUserId/);
  });

  test('**动作映射不到三种状态时保持 null，不硬塞**', () => {
    // 「收藏图书到豆列」不是一个标记状态。塞进 wish/done/doing 任何一格都是编造。
    const html = wrap(OWNER, '<a class="lnk-people">MewX</a> 收藏图书到豆列')
      .replace('</div></div>', '</div>'
        + '<span class="created_at" title="2026-01-01 00:00:00">x</span></div>');
    const b = extractBroadcasts(html, OWNER).broadcasts[0];
    assert.equal(b.status, null);
    assert.equal(b.action, '收藏图书到豆列', '动作原文要留着');
  });

  test('同一条广播出现在相邻两页上只算一次', () => {
    // 头插列表翻页会重复。实测 3386 个 wrapper / 3382 个唯一 sid。
    const one = wrap(OWNER, '<span class="created_at" title="2026-01-01 00:00:00">x</span>');
    assert.equal(extractBroadcasts(one + one, OWNER).broadcasts.length, 1);
  });

  test('有时间戳却没有 sid → 计进 idless，好报警', () => {
    const html = '<div class="new-status status-wrapper" data-uid="82160871">'
      + '<span class="created_at" title="2026-01-01 00:00:00">x</span></div>';
    assert.equal(extractBroadcasts(html, OWNER).idless, 1);
  });
});

/**
 * 动作句 —— 整句，不是前七个字。
 *
 * 旧写法从人名之后取最多七个非 `<` 的字符。七看起来是「最长的动作词」
 * （`收藏图书到豆列` 正好七个），实际是**「在第一个行内链接前面刹住」**，
 * 而链接里装的正是这句话的宾语。下面每条夹具的结构都照真实页面写。
 */
describe('动作取整句', () => {
  /** 照真实页面：动作句在 `.text` 里，正文在 `<blockquote>` 里，其余都在外面。 */
  const say = (inner, { quote = null } = {}) =>
    '<div class="new-status status-wrapper" data-sid="1" data-uid="82160871">'
    + `<div class="text"><a class="lnk-people">MewX</a>\n      ${inner}\n    `
    + (quote === null ? '</div>' : `<blockquote><p>${quote}</p></blockquote></div>`)
    + '<span class="created_at" title="2026-01-01 00:00:00">x</span></div>';

  const actionOf = (html) => extractBroadcasts(html, OWNER).broadcasts[0].action;

  test('**12 个标记动作词一个都不许变形** —— 变了就丢一条标记事件', () => {
    // 这是这次改动唯一危险的方向：动作词一旦不是原样，ACTION_STATUS 查不到，
    // status 变成 null，而「这条广播没有状态」与「这条广播不是标记」在数据上
    // 分不出来。实测真实档案 3265 条有状态的广播：保住 3265、丢 0。
    for (const [word, status] of Object.entries({
      想看: 'wish', 想读: 'wish', 想听: 'wish', 想玩: 'wish',
      看过: 'done', 读过: 'done', 听过: 'done', 玩过: 'done',
      在看: 'doing', 在读: 'doing', 在听: 'doing', 在玩: 'doing',
    })) {
      const b = extractBroadcasts(say(word, { quote: '正文' }), OWNER).broadcasts[0];
      assert.equal(b.action, word, `${word} 被改动过了`);
      assert.equal(b.status, status, `${word} 映射不到 ${status}`);
    }
  });

  test('**行内链接里的宾语要收进来** —— 收藏到哪个豆列，原来一直是空的', () => {
    // 实测 61 条广播因为那个七字上限丢掉了豆列名。
    const html = say('收藏游戏到豆列 \n      <a href="https://www.douban.com/doulist/45473911/">游戏购买小账本</a>',
      { quote: '正文' });
    assert.equal(actionOf(html), '收藏游戏到豆列 游戏购买小账本');
  });

  test('传照片到相册：整句读得出来，而且不跟作品名粘在一起', () => {
    const html = say('上传了17张照片到 <a href="https://www.douban.com/game/30246116/">寂静之人 THE QUIET MAN</a>'
      + ' 的 <a href="https://www.douban.com/game/30246116/photos/">相册</a>');
    assert.equal(actionOf(html), '上传了17张照片到 寂静之人 THE QUIET MAN 的 相册');
  });

  test('**标签直接删掉 —— 判据是「浏览器会显示成什么」**', () => {
    // 第一版是「换成空格」，怕把两个词粘起来。**那个担心是编的**：浏览器渲染行内
    // HTML 就是「去标签 + 折叠空白」，该有空格的地方豆瓣源码里本来就有。换成空格
    // 反而造出页面上没有的空格——实测 4 条广播的书名号里凭空多了两个。
    // 这个毛病是看生成出来的站点看出来的，不是想出来的。
    assert.equal(actionOf(say('写了《<a href="/x">千と千尋の神隠し</a>》的讨论：', { quote: 'q' })),
      '写了《千と千尋の神隠し》的讨论', '书名号里不许多出空格');
    // 而豆瓣自己带了空格的地方，空格还在：
    assert.equal(actionOf(say('收藏游戏到豆列 \n      <a href="/x">游戏购买小账本</a>', { quote: 'q' })),
      '收藏游戏到豆列 游戏购买小账本');
  });

  test('实体要解码 —— 不解的话它会被原样印在页面上', () => {
    // 站点生成器会把 `&` 转义成 `&amp;`，所以这里没解开的实体最后会**显示出来**。
    // sample.doubak.com 上那个可见的 `&#34;` 就是这么来的。
    assert.equal(actionOf(say('写了关于 <a href="/x">Tom Clancy&#39;s Ghost Recon</a> 的文字', { quote: 'q' })),
      '写了关于 Tom Clancy\u2019s Ghost Recon 的文字'.replace('\u2019', "'"));
  });

  test('**结尾的冒号去掉，两种宽度都去**', () => {
    // 它是动作与引文之间的分隔符，而豆瓣半角全角都写：CLAUDE.md 记着 action 那
    // 59 对相邻修订差异里有 49 对只差冒号宽窄（老页面 `说:`，新页面 `说：`）。
    assert.equal(actionOf(say('说:', { quote: '正文' })), '说');
    assert.equal(actionOf(say('说：', { quote: '正文' })), '说');
    assert.equal(actionOf(say('喜欢\n      \n:', { quote: '正文' })), '喜欢');
  });

  test('**开头的冒号不去** —— 那一条豆瓣本来就没写动作词', () => {
    // 实测 1 条：页面上原样显示 `MewX : 《斯诺登…》预告片`。照抄比替它编一个动词
    // 诚实，而 n=1 也不够推出任何规则。
    assert.equal(actionOf(say(': <a href="/x">《斯诺登 Snowden (2016)》预告片</a>', { quote: 'q' })),
      ': 《斯诺登 Snowden (2016)》预告片');
  });

  test('豆瓣压根没写动作词时是 null，不是空串', () => {
    // 日记广播就是这样：`<span type="note"></span>` 之后直接是卡片。
    // 空串会让下游分不清「没有动作」和「有一个空动作」。
    assert.equal(actionOf(say('<span type="note"></span>')), null);
  });

  test('**右边界是结构，不是长度** —— 时间戳不许被吃进动作句', () => {
    // 实测 21754 条真实广播里，时间戳落进动作句范围的有 0 条。
    // 这条守的是「万一有」：切到 `.text` 的 `</div>` 就停。
    assert.equal(actionOf(say('想看')), '想看');
  });
});

/**
 * 动作句里的链接。
 *
 * 只留文字的话，`收藏游戏到豆列 游戏购买小账本` 在站点上是一句点不动的话——
 * 而它在豆瓣上三个词都能点。`action` 照旧是给人看的整句（`ACTION_STATUS` 也按它
 * 精确查表），`actionParts` 是同一句话的结构化分段。
 *
 * 与 `bundle/1.4` 给缺口配 `detail` + `url` 是同一个形状，理由也一样：拿整句去做
 * 子串匹配把链接对回去，靠的是两边实体解码分毫不差，而**对不上时是静默的**。
 */
describe('动作句里的链接', () => {
  const say = (inner, { quote = null } = {}) =>
    '<div class="new-status status-wrapper" data-sid="1" data-uid="82160871">'
    + `<div class="text"><a class="lnk-people">MewX</a>\n      ${inner}\n    `
    + (quote === null ? '</div>' : `<blockquote><p>${quote}</p></blockquote></div>`)
    + '<span class="created_at" title="2026-01-01 00:00:00">x</span></div>';
  const one = (html) => extractBroadcasts(html, OWNER).broadcasts[0];

  test('**拼起来必须逐字等于 action** —— 这条不成立，这个字段就只是又一次子串匹配', () => {
    for (const inner of [
      '收藏游戏到豆列 \n      <a href="https://www.douban.com/doulist/45473911/">游戏购买小账本</a>',
      '上传了17张照片到 <a href="https://www.douban.com/game/30246116/">寂静之人 THE QUIET MAN</a>'
        + ' 的 <a href="https://www.douban.com/game/30246116/photos/">相册</a>',
      '写了《<a href="https://movie.douban.com/subject/1291561/">千と千尋の神隠し</a>》的讨论：',
      '想看',
    ]) {
      const b = one(say(inner, { quote: '正文' }));
      const rebuilt = (b.actionParts ?? [{ text: b.action }]).map((x) => x.text).join('');
      assert.equal(rebuilt, b.action, `拼不回去：${JSON.stringify(inner)}`);
    }
  });

  test('豆列：名字和它的地址都留住', () => {
    const b = one(say('收藏游戏到豆列 \n      '
      + '<a href="https://www.douban.com/doulist/45473911/">游戏购买小账本</a>', { quote: 'q' }));
    assert.equal(b.action, '收藏游戏到豆列 游戏购买小账本');
    assert.deepEqual(b.actionParts, [
      { text: '收藏游戏到豆列 ' },
      { text: '游戏购买小账本', url: 'https://www.douban.com/doulist/45473911/' },
    ]);
  });

  test('一句话里两个链接（作品 + 相册），次序不能乱', () => {
    const b = one(say('上传了17张照片到 <a href="https://www.douban.com/game/30246116/">寂静之人</a>'
      + ' 的 <a href="https://www.douban.com/game/30246116/photos/">相册</a>'));
    assert.deepEqual(b.actionParts.map((x) => x.url ?? null), [
      null, 'https://www.douban.com/game/30246116/', null, 'https://www.douban.com/game/30246116/photos/',
    ]);
    assert.deepEqual(b.actionParts.map((x) => x.text), ['上传了17张照片到 ', '寂静之人', ' 的 ', '相册']);
  });

  test('**没有链接就是 null，不是只有一段的数组**', () => {
    // 3423 条广播里带链接的只有 90 条。其余都给一份单段数组，等于把同一句话
    // 在每条记录里存两遍，而第二遍一个字都不多。
    assert.equal(one(say('想看', { quote: '正文' })).actionParts, null);
  });

  test('href 里的实体要解码', () => {
    // 真实页面上有 `?icn=status_board&amp;cate=`。不解码的话链接是坏的，
    // 而坏在查询串上——点得开、少个参数，不会报错。
    const b = one(say('向 <a href="https://www.douban.com/board/1000407/?icn=status_board&amp;cate=">'
      + '某个榜单</a> 分享'));
    assert.equal(b.actionParts.find((x) => x.url).url,
      'https://www.douban.com/board/1000407/?icn=status_board&cate=');
  });

  test('**跨段的空白也要折叠** —— 不然拼不回整句', () => {
    // `到豆列 ` 后面接 ` 名字` 会拼出两个空格，而整句折叠只有一个。
    const b = one(say('收藏到豆列 \n   <a href="/x"> 名字</a>', { quote: 'q' }));
    assert.equal(b.action, '收藏到豆列 名字');
    assert.equal(b.actionParts.map((x) => x.text).join(''), b.action);
  });

  test('结尾的冒号去掉之后，最后一段也要跟着去', () => {
    const b = one(say('写了《<a href="/x">千と千尋</a>》的讨论：', { quote: 'q' }));
    assert.equal(b.action, '写了《千と千尋》的讨论');
    assert.equal(b.actionParts.at(-1).text, '》的讨论');
    assert.equal(b.actionParts.map((x) => x.text).join(''), b.action);
  });
});

describe('豆瓣把长广播截断了', () => {
  const wrap = (inner) => `<div class="new-status status-wrapper" data-uid="1" data-sid="9">`
    + `<span class="created_at" title="2025-04-14 18:47:50"></span>`
    + `<blockquote><p>${inner}</p></blockquote></div>`;

  test('**认那个 `<a>` 元素，不认「（全文）」这三个字**', () => {
    // 按文字认的话，一条用户自己打了「（全文）」结尾的广播会被误判成截断——
    // 给一条完整正文盖上「不完整」的戳，和漏判一样是在说假话。
    const cut = extractBroadcasts(
      wrap('开头一段…<a href="https://www.douban.com/note/872015292/">（全文）</a>'), '1');
    assert.equal(cut.broadcasts[0].fullTextUrl, 'https://www.douban.com/note/872015292/');

    const typed = extractBroadcasts(wrap('我写完了（全文）'), '1');
    assert.equal(typed.broadcasts[0].fullTextUrl, null, '用户自己打的字不该被当成截断');
    assert.equal(typed.broadcasts[0].text, '我写完了（全文）');
  });

  test('**「（全文）」不进正文** —— 它是豆瓣的链接文字，不是用户写的字', () => {
    // 与「未知作品」「1740人浏览」「暂无封面」同一条规则：占位符不是内容。
    const r = extractBroadcasts(
      wrap('开头一段…<a href="https://www.douban.com/note/1/">（全文）</a>'), '1');
    assert.equal(r.broadcasts[0].text, '开头一段…');
    assert.ok(!/全文/.test(r.broadcasts[0].text));
  });

  test('没被截断的就是 null，不是空串', () => {
    assert.equal(extractBroadcasts(wrap('短广播'), '1').broadcasts[0].fullTextUrl, null);
  });
});

describe('对着真实档案', () => {
  const DL = ARCHIVE_20260806;

  /**
   * 整份档案只解析一次。**不是省时间，是「跑不跑得起来」**——26 份档案一次约
   * 25 秒，这个文件里两处各解析一遍就是接近一分钟。共用是安全的：`parse()` 是
   * 纯函数，下面两条都只读。（这两条测试原来指着一条已经不存在的路径，
   * 于是**永远跳过**；见 real-archive.js。）
   */
  let _real;
  const realParse = () => (_real ??= parse(openAll(DL)));

  test('**广播里用户写的那部分不可编辑**（作品名不算，那是豆瓣的）', async (t) => {
    if (!existsSync(DL)) return t.skip('真实档案不在这台机器上');
    const { broadcasts } = await realParse();
    // **不钉死条数。** 那个目录会随着新抓取长大——第一版写死 3392，用户多跑了一次
    // 就红了，而什么都没坏。钉死一个会自然变化的数，测的是「档案有没有变」，
    // 不是「解析器对不对」。
    assert.ok(broadcasts.length > 3000, `只有 ${broadcasts.length} 条，像是没读到`);

    // 这条断言原先写的是「修订数恒等于记录数」，理由是广播发布后不可编辑。
    //
    // **那个前提只对一半。** 2026-08-20 并进 4 份 7 月 31 日的档案之后它红了：
    // 3480 条修订对 3411 条记录。查下来 69 组相邻版本的差异**全部只在
    // `target_title` 一个字段上**，一条都没碰 `text` / `rating` / `posted_at`。
    //
    // 因为挂在广播下面那张作品卡**不是**发布时冻住的——豆瓣是在你打开页面那一刻
    // 现渲染它的。所以「F1：狂飙飞车」在 7 月抓到，8 月再抓就成了「F1」：
    // 那是豆瓣改了自己的目录，不是用户改了广播。
    //
    // 一比一那个写法会把这类真实变化当成故障，而它恰恰是这个项目想留住的东西
    // ——豆瓣自己不保留的改名历史。所以判据改成：**用户写的字一个都不许变，
    // 允许变的只有豆瓣的作品名。**
    // **2026-08-30 再收窄一次，理由与上一次同源，证据强得多。**
    //
    // 把前代工具 2022–2024 的档案并进来之后，这张表里除了 target_title 之外
    // 又有四个字段动了，而**没有一个是用户改的**——全是豆瓣自己四年间换了
    // 渲染方式：
    //
    //   action 59 对   49 对只差一个冒号的宽窄（老页面 `说:`，新页面 `说：`，
    //                  实测每一个带冒号的动作都恰好两种写法、按档案来源完全
    //                  分开、零反例）；另外 10 对是豆瓣改了自己的措辞，
    //                  例如 `分享了` → `转发了`
    //   text    9 对   4 对是 `\r\n\r\n` 被压成 `\r\n`，1 对是 `&trade;`
    //                  与 `&amp;trade;` 的转义差别，3 对是老页面的正文这边
    //                  读不出来（null → 有字）
    //   images 27 对   老页面上那种 `upload-pic-wrapper` 附图还没认出来
    //   target_type / target_id 各 4 对
    //
    // 「发出去就不能改」说的是**用户改不了**，它从来没有承诺豆瓣四年不换模板。
    // 把这两件事写进同一张表，结果就是拿豆瓣的排版变化去指控用户编辑了广播。
    //
    // 所以真正冻住的只剩这五个——实测在全部 3856 条修订里**一次都没变过**：
    const FROZEN = ['posted_at', 'rating', 'status', 'text_truncated', 'full_text_url'];
    let compared = 0;
    for (const b of broadcasts) {
      const revs = [...b.revisions].sort((x, y) => (x.first_observed_at < y.first_observed_at ? -1 : 1));
      for (let i = 1; i < revs.length; i++) {
        compared += 1;
        for (const f of FROZEN) {
          assert.deepEqual(
            revs[i].fields[f], revs[i - 1].fields[f],
            `广播 ${b.upstream_id} 的 ${f} 变了 —— 广播发出去之后用户改不了它，`
            + '这说明抽取器或页面结构变了',
          );
        }
      }
    }
    assert.ok(compared > 0, '没有一条广播有多个修订，那上面那段循环什么也没测');

    // **被移出去的那几个不是不管了，是改成上界。**
    //
    // 直接删掉它们，等于把「豆瓣渲染变了」与「抽取器坏了」一起放行——而后者
    // 恰恰是这条测试存在的理由。写成上界：认出老页面的附图写法会让 images
    // 那个数下降（绿），而任何一处新的抽取器退化都会让它上涨（红）。
    //
    // **2026-09-06：action 从 59 收到 13。** 动作改成取整句之后，结尾那个冒号
    // 被去掉了——而 59 里有 49 对差异**只差冒号宽窄**（老页面 `说:`，新页面 `说：`）。
    // 那 49 对不是豆瓣改了措辞，是同一个动作的两种排版，收掉之后这个上界才重新
    // 有意义：留在 59 等于给 46 次真的抽取器退化预先放行。
    //
    // **2026-09-06：加了 action_parts，上界 15，比 action 的 13 多 2。**
    // 多出来的是 href 变了而文字没变的那几条，实测三种，没有一种是我们的抽取器抖：
    // 豆瓣把小组渲染成 `group/networks/` 或 `group/145884/`（同一个组的两种写法），
    // 以及一条广播指向的 subject id 真的换了。**那是豆瓣自己改的，与 target_title
    // 那 380 条同类**，所以进上界而不是进 FROZEN。
    const CHURN = {
      target_title: 380, action: 13, action_parts: 15, images: 27, target_type: 4, target_id: 4, text: 9,
    };
    const seen = {};
    for (const b of broadcasts) {
      const revs = [...b.revisions].sort((x, y) => (x.first_observed_at < y.first_observed_at ? -1 : 1));
      for (let i = 1; i < revs.length; i++) {
        for (const f of Object.keys(CHURN)) {
          const [a, z] = [revs[i - 1].fields[f], revs[i].fields[f]];
          if (JSON.stringify(a) !== JSON.stringify(z)) seen[f] = (seen[f] ?? 0) + 1;
        }
      }
    }
    for (const [f, cap] of Object.entries(CHURN)) {
      assert.ok(
        (seen[f] ?? 0) <= cap,
        `${f} 在相邻修订间变了 ${seen[f]} 次，实测上界是 ${cap}——涨了就是新的抽取器退化，`
        + '不是豆瓣又改了模板（模板变化不会让这个数往上走）',
      );
    }
    assert.ok(broadcasts.some((b) => b.revisions[0].observations.length > 1), '没有一条被观测多次，那这条测试就是空的');
  });

  test('**被标记页覆盖掉的短评，广播里还在**', async (t) => {
    if (!existsSync(DL)) return t.skip('真实档案不在这台机器上');
    // 这是整个项目要买的东西：不是「我标了什么」，而是「我当时说了什么」。
    // 那条「想看」短评在标记页上已经被「看过」的短评覆盖了。
    const { broadcasts, marks } = await realParse();
    const bc = broadcasts.find((b) => (b.revisions[0].fields.text ?? '').includes('能上6分'));
    assert.ok(bc, '广播里找不到那条被覆盖的短评');
    assert.equal(bc.revisions[0].fields.posted_at.precision, 'second');

    // 而且它能连回那条标记——data-object-id 就是作品 id。
    const mark = marks.find((m) => m.subject.id === bc.revisions[0].fields.target_id);
    assert.ok(mark, '广播连不回标记');
    assert.equal(mark.revisions.length, 2, '那条标记应当有两版（想看 → 看过）');

    // 最新一版的短评**不是**当初那一条——那正是要点：标记页上只剩下最新的。
    //
    // 注意不能断言「新短评里不含旧短评的文字」：实测这位用户在「看过」的长评里
    // 原话引了自己当初那句（「…之前就说能上6分我觉得都是国产好片。这个女主也特别
    // 眼熟…」）。写成 `includes` 的话这条测试会因为一个与它无关的巧合而变红。
    const latest = mark.revisions[1].fields.comment;
    const frozen = bc.revisions[0].fields.text;
    assert.notEqual(latest, frozen, '标记页上还留着原样的旧短评，那这条测试就没意义了');
    assert.equal(mark.revisions[0].fields.comment, frozen,
      '广播冻结的那一句应当与标记的第一版逐字相同 —— 两个独立来源互相印证');
  });
});
