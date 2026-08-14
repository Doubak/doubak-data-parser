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
