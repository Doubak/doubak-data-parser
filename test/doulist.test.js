/**
 * 豆列。
 *
 * ## 夹具是**浏览器另存**的页面，不是抓取到的字节
 *
 * `extract-longform.js` 顶上记着一次真实的教训：另存的那份跑过 JS，`<h1>` 里已经是
 * 纯文字；抓取拿到的原始 HTML 里 `<h1>` 套着 `<span property="v:summary">`。照另存
 * 的那份写选择器会在真实数据上落空。
 *
 * 这里同样是另存的，所以抽取面只用**服务端渲染**的那些：`data-*` 属性、
 * `blockquote.comment`、`id="doulist-info"`——前端脚本生成不出这些。也检查过这 4 份
 * 里没有 `<base href>`、没有「saved from url」注释、没有相对化的资源路径。
 *
 * **但这是推断不是测量。第一次真实抓取之后要拿真实字节复核一遍**，尤其是
 * `visibility`：它错了会把用户明确隐藏的东西发出去。
 *
 * | 夹具 | 是什么 | 条目 | 带评语 |
 * |---|---|---|---|
 * | `doulists-index.html`           | 我创建的豆列（索引） | 6 | — |
 * | `doulist-detail-comments.html`  | 游戏购买小账本       | 25 | 24 |
 * | `doulist-detail-bookmarks.html` | 我的收藏（纯书签夹） | 25 | **0** |
 * | `doulist-detail-private.html`   | SELECTS（私密）      | 1 | 0 |
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  extractDoulist, extractDoulistItems, extractDoulistLinks, extractVisibility,
  mergeDoulistPages,
} from '../src/extract-doulist.js';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf-8');
const INDEX = fx('doulists-index.html');
const LEDGER = fx('doulist-detail-comments.html');
const BOOKMARKS = fx('doulist-detail-bookmarks.html');
const PRIVATE = fx('doulist-detail-private.html');

describe('索引页：哪几份豆列', () => {
  test('6 条，每条一次', () => {
    const urls = extractDoulistLinks(INDEX);
    assert.equal(urls.length, 6);
    assert.ok(urls.includes('https://www.douban.com/doulist/45473911/'));
  });

  test('页面上每条有两处同样的链接，别数成 12', () => {
    // 封面一处、标题一处。限定在 <h3> 里就只剩一处。
    assert.equal((INDEX.match(/douban\.com\/doulist\/\d+/g) ?? []).length, 12);
    assert.equal(extractDoulistLinks(INDEX).length, 6);
  });

  test('认不出来就返回空，不猜', () => {
    assert.deepEqual(extractDoulistLinks('<html></html>'), []);
    assert.deepEqual(extractDoulistLinks(null), []);
  });
});

describe('详情页：清单本身', () => {
  test('标题、简介、可见性都抽得出来', () => {
    const d = extractDoulist(LEDGER, 'https://www.douban.com/doulist/45473911/');
    assert.equal(d.id, '45473911');
    assert.equal(d.title, '游戏购买小账本');
    assert.match(d.description, /我的信仰值有多少/);
    assert.equal(d.visibility, 'public');
    assert.equal(d.items.length, 25);
  });

  test('**标题里不能混进那个私密图标**', () => {
    // `<h1>` 里除了标题还有 `<i class="is-private">`。去标签之后应当只剩标题。
    const d = extractDoulist(PRIVATE, 'https://www.douban.com/doulist/162349128/');
    assert.equal(d.title, 'SELECTS');
    assert.equal(d.visibility, 'private');
  });

  test('框架标志不中就返回 null —— 不返回一个「空豆列」', () => {
    // 豆瓣以 HTTP 200 送封锁页是既有事实。一个「标题 null、条目空」的记录，
    // 与一份真的空豆列长得一模一样。
    assert.equal(extractDoulist('<html><body>封锁页</body></html>', 'https://x/doulist/1/'), null);
    assert.equal(extractDoulist(null), null);
  });
});

describe('可见性：这一条错了会把用户明确隐藏的东西发出去', () => {
  test('私密判 private，公开判 public', () => {
    assert.equal(extractVisibility(PRIVATE), 'private');
    assert.equal(extractVisibility(LEDGER), 'public');
    assert.equal(extractVisibility(BOOKMARKS), 'public');
  });

  test('**找不到 h1 是第三种结果，不能并进 public**', () => {
    // 并进去的话，豆瓣改版那天所有私密豆列静默变成公开。
    assert.equal(extractVisibility('<html><body>没标题</body></html>'), 'unknown');
    assert.equal(extractVisibility(null), 'unknown');
  });

  test('**喂给索引页会得到错的答案 —— 调用方必须先按 intent 分流**', () => {
    // 索引页自己也有一个 <h1>（内容是「我的豆列」），于是这个判据会走到
    // 「h1 里没有标记」→ public。错的答案，而且方向是最坏的那个。
    // 索引页在 <h3> 里另有一个同名标记，而据档案主人实测那个不可靠。
    assert.match(INDEX, /<h1>\s*我的豆列\s*<\/h1>/);
    assert.match(INDEX, /<h3>[\s\S]*?class="is-private"/);
    assert.equal(extractVisibility(INDEX), 'public', '记录在案：这就是那个错的答案');
  });
});

describe('条目：值钱的是评语', () => {
  test('25 条里 24 条有评语，那条消费记录原样在', () => {
    const items = extractDoulistItems(LEDGER);
    assert.equal(items.length, 25);
    const withComment = items.filter((i) => i.comment);
    assert.equal(withComment.length, 24);
    assert.ok(
      withComment.some((i) => /A\$49\.21.*amazon/.test(i.comment)),
      '带价格的那条流水丢了',
    );
  });

  test('**「评语：」是 UI 标签，不进内容**', () => {
    // 与「（全文）」「未知作品」同理：占位符不是内容。
    const items = extractDoulistItems(LEDGER).filter((i) => i.comment);
    assert.ok(items.every((i) => !i.comment.startsWith('评语')), items[0].comment);
  });

  test('**0 条评语是合法形态，不是抽取失败**', () => {
    // 「我的收藏」是纯书签夹：25 条全指向他人的 /review/。把这当故障，
    // 这一类豆列每次抓取都会报一次假警。
    const items = extractDoulistItems(BOOKMARKS);
    assert.equal(items.length, 25);
    assert.equal(items.filter((i) => i.comment).length, 0);
    assert.ok(items.every((i) => i.url?.includes('/review/')), '这一份的条目全是他人的评论');
  });

  test('条目 id 是收藏动作的 id，作品 id 另有其字段', () => {
    const [first] = extractDoulistItems(LEDGER);
    assert.equal(first.entryId, '770340559');
    assert.equal(first.upstreamId, '30237482');
    assert.notEqual(first.entryId, first.upstreamId);
  });

  test('目录数据抽得全，且与用户写的分开', () => {
    const [first] = extractDoulistItems(LEDGER);
    assert.match(first.title, /刺客信条/);
    assert.equal(first.url, 'https://www.douban.com/subject/30237482/');
    assert.match(first.coverUrl, /^https:\/\/img\d*\.doubanio\.com\//);
    assert.match(first.abstract, /古希腊/, '简介是豆瓣写的');
    assert.match(first.rating, /8\.4/, '评分是豆瓣的');
    assert.ok(first.comment && !first.comment.includes('古希腊'), '评语不能混进简介');
  });

  test('**评分原样存字符串，不解析成数字**', () => {
    // 它会自己变。拿它算摘要，豆瓣评分一动就凭空多一条修订——与长文正文吞进
    // 「1740人浏览」同一类错。存字符串是为了让「不要拿它算摘要」显而易见。
    const [first] = extractDoulistItems(LEDGER);
    assert.equal(typeof first.rating, 'string');
    assert.match(first.rating, /人评价/, '连「N人评价」一起留着 —— 它本来就不是个分数');
  });

  test('类型码原样保留，不映射成 medium', () => {
    // 豆列里装得下作品之外的东西：实测 1012 是他人的评论。翻译它等于把一个开放
    // 词表压进一个封闭词表。
    assert.equal(extractDoulistItems(LEDGER)[0].category, '3114');
    assert.equal(extractDoulistItems(BOOKMARKS)[0].category, '1012');
  });

  test('条目次序就是页面次序 —— 排过的清单，重排等于改内容', () => {
    const ids = extractDoulistItems(LEDGER).map((i) => i.entryId);
    const order = [...LEDGER.matchAll(/<div\s+id="(\d+)"\s+class="doulist-item"/g)].map((m) => m[1]);
    assert.deepEqual(ids, order);
  });

  test('只有 1 条的豆列也照常抽', () => {
    assert.equal(extractDoulistItems(PRIVATE).length, 1);
  });

  test('实体要解码 —— 不然页面上会印出 &#39;', () => {
    // 与整个仓库共用一份 html-entities：解析器不解码，生成器会忠实地把它转义、
    // 印在页面上。sample.doubak.com 上那个可见的 `&#34;` 就是这么来的。
    const items = extractDoulistItems(LEDGER);
    assert.ok(items.every((i) => !/&#\d+;|&amp;|&quot;/.test(i.title ?? '')), '标题里还有实体');
  });
});

/**
 * 把同一份豆列的几页拼起来。
 *
 * 这条规则原来有**两份实现**：解析器 `parse.js` 里一份，扩展面板的内容预览里一份。
 * 两份实现对同一份豆列可以给出不同的条目次序，而**次序错了看起来完全正常**——
 * 还是那些作品，还是那些评语。现在只有这一份，扩展那边原样拿过去
 * （`doubak-extension/src/vendor/parser/`，由 `tools/sync-extractors.mjs` 守新鲜度）。
 */
describe('几页拼成一份豆列', () => {
  const page = (start, ...titles) => ({
    start,
    doulist: { id: '45473911', title: '游戏购买小账本', items: titles.map((t) => ({ title: t })) },
  });

  test('**按 start 升序拼，不按传进来的次序**', () => {
    // 抓取顺序不可靠：广度优先的 frontier 会把几份豆列的页面交错排开，重试还会
    // 让某一页迟到。而用户排过的清单，把第 2 页排到第 1 页前面就是改了内容。
    const m = mergeDoulistPages([page(50, '第三页'), page(0, '第一页'), page(25, '第二页')]);
    assert.deepEqual(m.doulist.items.map((i) => i.title), ['第一页', '第二页', '第三页']);
  });

  test('标题这些取第一页的，条目是各页接起来', () => {
    const m = mergeDoulistPages([page(25, 'b'), page(0, 'a')]);
    assert.equal(m.doulist.title, '游戏购买小账本');
    assert.equal(m.doulist.id, '45473911');
    assert.equal(m.doulist.items.length, 2);
  });

  test('**每一页原样回传**，调用方靠它把自己挂的东西带回去', () => {
    // 解析器就是这样把每一页的 observation 带回去的（capture_ids 要全都指得回去）。
    const withExtra = [
      { ...page(25, 'b'), observation: { capture_ids: ['x#2'] } },
      { ...page(0, 'a'), observation: { capture_ids: ['x#1'] } },
    ];
    const m = mergeDoulistPages(withExtra);
    assert.deepEqual(m.pages.flatMap((p) => p.observation.capture_ids), ['x#1', 'x#2'],
      '回传的次序也要是 start 升序');
  });

  test('空页照拼 —— 那是翻页的正常终点，不是错误', () => {
    // 没有翻页器的豆列只能靠「再要一页、拿回来是空的」才知道到头，那一页照样进档案。
    const m = mergeDoulistPages([page(0, 'a'), page(25)]);
    assert.equal(m.doulist.items.length, 1);
    assert.equal(m.pages.length, 2, '页数不该被吞掉 —— 调用方要自己决定怎么说');
  });

  test('一页都没有就返回 null，不返回一份空豆列', () => {
    // 与 `extractDoulist` 认不出框架时同一条规矩：**一个「空记录」与一份真的空豆列
    // 长得一模一样**，而两者的含义完全不同。
    assert.equal(mergeDoulistPages([]), null);
  });

  test('**不分组** —— 传进来的就当成同一份豆列', () => {
    // 两个调用方的分组键不一样：解析器按「哪份档案里的哪份豆列」，面板按豆列。
    // 会悄悄出错的是拼接次序，不是分组；把分组也塞进来，这里就得认一个它不该
    // 知道的概念（档案）。
    //
    // 所以判据是**行为**而不是源码长相：喂两份不同的豆列，它照拼不误——
    // 「分组是调用方的事」这句话，只有这样才验得到。
    const other = { start: 0, doulist: { id: '99999', title: '别的豆列', items: [{ title: 'z' }] } };
    const m = mergeDoulistPages([page(25, 'b'), other, page(0, 'a')]);
    assert.equal(m.doulist.items.length, 3);
    assert.equal(m.doulist.id, '99999', 'start 相同时取先传进来的那一页 —— 它不认 id');
  });
});
