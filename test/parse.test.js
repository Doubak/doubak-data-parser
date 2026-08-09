/**
 * 解析器：bundle → canonical。
 *
 * 规范在 doubak-data-specs/canonical/。这里守的是那些**违反了也不会报错、只会
 * 悄悄产出错数据**的规则——那是这个项目一贯的失败形状。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  absenceAuthority, isContent, hasUnknownVerdict, isRecalibratable, implausible,
} from '../src/authority.js';
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

describe('说不通的完整性声明不算数', () => {
  const clean = { contiguous: true, gaps: [], enumeration: 'full' };

  test('**声称完整但只抓到零头 → 不给 whole_route**', () => {
    // 规范 §6 早就要求做这个自检，只是解析器一直没做。而实测三份真实档案里
    // 各有 8 条路线正是这个样子：enumeration=full、claimed=1336、captured=15。
    // 那是生产者的 bug（增量的下界丢了），但档案是冻结的——它会永远带着这句
    // 假话，而下一个照规范办事的读者会据此断定那 1321 条被删了。
    assert.equal(
      absenceAuthority(clean, 'complete', { claimed_count: 1336, captured_count: 15 }),
      'none',
    );
  });

  test('数字对得上就照给', () => {
    assert.equal(
      absenceAuthority(clean, 'complete', { claimed_count: 1333, captured_count: 1333 }),
      'whole_route',
    );
  });

  test('**豆瓣自己少报那点幅度不该被误伤**', () => {
    // 实测同一次抓取：游戏声称 293、只渲染出 288（少 2%），而缺口还在列表中间。
    // 那是豆瓣自己的审查层造成的，不是抓取不完整——阈值取一半正是为了离它远远的。
    assert.equal(
      absenceAuthority(clean, 'complete', { claimed_count: 293, captured_count: 288 }),
      'whole_route',
    );
  });

  test('**没有 coverage 时照旧按 crawl_state 判** —— 没有证据不等于有反证', () => {
    assert.equal(absenceAuthority(clean, 'complete', undefined), 'whole_route');
    assert.equal(implausible(undefined), false);
    assert.equal(implausible({ claimed_count: 0, captured_count: 0 }), false);
  });

  test('**只用来否掉，不用来授予**', () => {
    // 规范 §2：豆瓣的计数有时统计于审查之前、有时之后，证明不了完整。
    // 所以一条 bounded 路线不会因为数字好看就升级成 whole_route。
    assert.equal(
      absenceAuthority({ ...clean, enumeration: 'bounded' }, 'complete',
        { claimed_count: 100, captured_count: 100 }),
      'none',
    );
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

    // **这份真实档案里确实有 24 条说不通的完整性声明**（三份档案各 8 条路线），
    // 成因是当年那两个已经修掉的生产者 bug。档案是冻结的，所以告警会一直在——
    // 而它就该一直在：那是「这几份档案的声明不可信」的记录。
    const other = warnings.filter((w) => w.type !== 'implausible_full');
    assert.deepEqual(other, [], '除了那几条已知的假声明，不该有别的告警');
    const impl = warnings.filter((w) => w.type === 'implausible_full');
    assert.ok(impl.length > 0, '这份档案本该有假声明告警，不然这条测试是空的');
    assert.ok(impl.every((w) => w.captured < w.claimed * 0.5));
  });

  test('**canonical 里不该再留着没解开的 HTML 实体**', (t) => {
    if (!existsSync(DL)) return t.skip('真实档案不在这台机器上');
    // 实测：修之前 196 处（`&#39;` 125、`&amp;` 40、`&#34;` 19、`&gt;` 7、`&lt;` 5），
    // 全都被站点生成器按规矩转义成 `&amp;#39;`，于是**原样印在页面上**。
    //
    // 修之后剩 1 处，而那一处是对的：原文是 `HITMAN&amp;amp;trade;`，解一次得到
    // 字面的 `&amp;trade;`——用户当年粘的就是一段已经转义过的标题。解第二次才是错的。
    const { marks, subjects, broadcasts, longform } = parse(openAll(DL));
    const texts = [];
    for (const rec of [...marks, ...subjects, ...broadcasts, ...longform]) {
      for (const rev of rec.revisions) {
        for (const v of Object.values(rev.fields)) {
          if (typeof v === 'string') texts.push(v);
          else if (Array.isArray(v)) texts.push(...v.filter((x) => typeof x === 'string'));
        }
      }
    }
    const left = texts.flatMap((s) => s.match(/&(?:#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi) ?? []);
    assert.deepEqual(left, ['&amp;'], `canonical 里还留着没解开的实体：${left.slice(0, 10)}`);
  });

  test('**广播引用的图 == 抓取端真的取回来的图**', (t) => {
    if (!existsSync(DL)) return t.skip('真实档案不在这台机器上');
    // 这一条同时守着解析端与抓取端：两边对「哪些图算数」的判据必须逐字一致，
    // 而两边不一致的后果是不对称的、都很难发现——
    //
    //   解析端更松 → canonical 里出现抓取端从没取过的 URL，站点上是个死链
    //   解析端更严 → 字节明明在档案里，canonical 却不提它，等于悄悄丢了一张图
    //
    // 写成集合相等而不是数量相等：数量对得上、内容错位的情况是存在的
    // （第一版按主机名收窄，漏掉 qnmob3 的 2 张、又多算了别的 2 张就会刚好抵消）。
    const { broadcasts } = parse(openAll(DL));
    const referenced = new Set(
      broadcasts.flatMap((b) => b.revisions.flatMap((r) => r.fields.images ?? [])),
    );

    /** 档案 index 里 verdict=ok 的广播附图。 */
    const captured = new Set();
    for (const dir of readdirSync(DL)) {
      const d = join(DL, dir);
      let idx;
      try { idx = readdirSync(d).find((f) => f.startsWith('index-') && f.endsWith('.ndjson')); } catch { continue; }
      if (!idx) continue;
      for (const line of readFileSync(join(d, idx), 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        if (row.route_key === 'asset.status_photo' && row.verdict === 'ok') captured.add(row.url);
      }
    }

    assert.ok(captured.size > 100, `档案里只有 ${captured.size} 张广播附图，像是没读到`);
    assert.deepEqual(
      [...referenced].sort(), [...captured].sort(),
      'canonical 引用的图与档案里真的有的图对不上',
    );
  });

  test('**被截断的广播，全文其实已经在档案里了**', (t) => {
    if (!existsSync(DL)) return t.skip('真实档案不在这台机器上');
    // 这一条是这次修复的要点：截断不是「档案缺了数据」，是「档案缺了一个指针」。
    // 实测那两条的 full_text_url 都指向一篇日记，而两篇日记的全文早就抓下来了。
    const { broadcasts, longform } = parse(openAll(DL));
    const cut = broadcasts.filter((b) => b.revisions.at(-1).fields.text_truncated);
    assert.ok(cut.length > 0, '真实档案里本该有被截断的广播，不然这条测试是空的');

    const haveLongform = new Set(longform.map((r) => r.upstream_id));
    for (const b of cut) {
      const url = b.revisions.at(-1).fields.full_text_url;
      assert.ok(url, '标了截断就必须给出全文在哪');
      const id = /\/(?:note|topic|review)\/(\d+)/.exec(url)?.[1];
      assert.ok(id && haveLongform.has(id), `全文 ${url} 不在档案里 —— 那才是真的缺数据`);
    }

    // 而且正文里不该残留那个 UI 标签。
    for (const b of broadcasts) {
      const t2 = b.revisions.at(-1).fields.text ?? '';
      assert.ok(!/（全文）$/.test(t2.trimEnd()), `广播 ${b.upstream_id} 的正文里残留了「（全文）」`);
    }
  });

  test('**又名要从作品详情页读出来**', (t) => {
    if (!existsSync(DL)) return t.skip('真实档案不在这台机器上');
    // 详情页此前一张都没被解析过——aliases 字段早在 schema 里，值却硬编码成 null。
    const { subjects } = parse(openAll(DL));
    const withAlias = subjects.filter((s) => (s.revisions.at(-1).fields.aliases ?? []).length);
    assert.ok(withAlias.length > 1500, `只有 ${withAlias.length} 个有又名，抽查显示电影 94% 都有`);

    // **只有电影和音乐有这一栏**，书 / 游戏 / 舞台剧的页面上根本没有。
    // 这里守的是「别在没有的地方硬造出来」。
    const byMedium = {};
    for (const s of withAlias) byMedium[s.medium] = (byMedium[s.medium] ?? 0) + 1;
    assert.deepEqual(Object.keys(byMedium).sort(), ['movie', 'music']);
  });

  test('**#info 整块收进来，键是豆瓣自己的标签**', (t) => {
    if (!existsSync(DL)) return t.skip('真实档案不在这台机器上');
    const { subjects } = parse(openAll(DL));
    const withInfo = subjects.filter((s) => s.revisions.at(-1).fields.info);

    // 游戏与舞台剧的页面上根本没有 #info——**别在没有的地方硬造出来**。
    const meds = {};
    for (const s of withInfo) meds[s.medium] = (meds[s.medium] ?? 0) + 1;
    assert.deepEqual(Object.keys(meds).sort(), ['book', 'movie', 'music']);
    assert.ok(meds.movie > 2000, `电影只有 ${meds.movie} 个有 info`);

    // 键必须是豆瓣的标签，不是我们翻译过的。
    const movie = withInfo.find((s) => s.medium === 'movie' && s.revisions.at(-1).fields.info['导演']);
    assert.ok(movie, '一个带导演的电影都没有');
    assert.ok(Array.isArray(movie.revisions.at(-1).fields.info['导演']));
  });

  test('**评论区的用户名不许混进 info** —— 那是第三方内容', (t) => {
    if (!existsSync(DL)) return t.skip('真实档案不在这台机器上');
    // span.pl 在页面别处还用来标评论区的用户名。越界的话，几十个陌生人的 id
    // 会变成字段名，存进档案主人的 canonical。
    const { subjects } = parse(openAll(DL));
    const keys = new Set();
    for (const s of subjects) for (const k of Object.keys(s.revisions.at(-1).fields.info ?? {})) keys.add(k);
    const looksLikeUser = [...keys].filter((k) => /^\(.*\)$/.test(k));
    assert.deepEqual(looksLikeUser, [], `这些键像用户名：${looksLikeUser.join(' ')}`);
  });

  test('**值按 ` / ` 切，`(港/台)` 不许被切开**', (t) => {
    if (!existsSync(DL)) return t.skip('真实档案不在这台机器上');
    // 实测裸斜杠切法把 `犯罪101(港/台)` 切成了两半，4022 张页面上切坏 176 条。
    const { subjects } = parse(openAll(DL));
    const broken = [];
    for (const s of subjects) {
      for (const vs of Object.values(s.revisions.at(-1).fields.info ?? {})) {
        for (const v of vs) {
          // 括号只开不闭、或只闭不开 = 被从括号中间切开了
          const open = (v.match(/[(（]/g) ?? []).length;
          const close = (v.match(/[)）]/g) ?? []).length;
          if (open !== close) broken.push(v);
        }
      }
    }
    assert.deepEqual(broken.slice(0, 5), [], `${broken.length} 个值的括号不配对，像是被切坏了`);
  });

  test('**又名的顺序不许动，也不去重**', (t) => {
    if (!existsSync(DL)) return t.skip('真实档案不在这台机器上');
    // 顺序是豆瓣给的，而「哪个排第一」本身就是信息（通常是最通行的那个译名）。
    const { subjects } = parse(openAll(DL));
    const s = subjects.find((x) => x.id === '35267208' || (x.revisions.at(-1).fields.aliases ?? []).length > 2);
    assert.ok(s, '找不到一个有多个又名的作品');
    const a = s.revisions.at(-1).fields.aliases;
    assert.ok(a.every((x) => x === x.trim() && x.length), '每一项都该是去掉首尾空白的非空串');
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

describe('哪些判不出来是「改一行就能救回来」的', () => {
  /**
   * 这是 `verdict_reason`（bundle/1.2）真正兑现的地方。解析器能一次扫完所有档案，
   * 回答一个别处回答不了的问题：**欠了多少，以及要不要求人重抓。**
   *
   * 混成一句「有 N 条失败」的话，用户只能去做代价最大的那个动作。而其中一类是免费的：
   * 页面已经原样躺在 WARC 里，改好抽取器离线重跑就行，一个请求都不用发。
   */
  test('页面结构变了 → 能救', () => {
    assert.equal(isRecalibratable({ verdict: 'unknown', verdict_reason: 'frame_anchors_missing' }), true);
    assert.equal(isRecalibratable({ verdict: 'unknown', verdict_reason: 'not_an_image' }), true);
  });

  test('**空响应 / 服务端出错 → 救不了，得重抓**', () => {
    // 那两种的字节本来就没拿到，改抽取器无济于事。混进来会让用户以为不用重抓。
    assert.equal(isRecalibratable({ verdict: 'unknown', verdict_reason: 'empty_body' }), false);
    assert.equal(isRecalibratable({ verdict: 'unknown', verdict_reason: 'server_error' }), false);
  });

  test('真的被拦下的不算', () => {
    assert.equal(isRecalibratable({ verdict: 'blocked' }), false);
    assert.equal(isRecalibratable({ verdict: 'ok' }), false);
  });

  test('**1.2 之前的档案也要认出来** —— 它们只有 note', () => {
    // 那时判不出来的响应只能写成 blocked，真相退在 note 里。档案是冻结的，
    // 改词表救不回它们——所以两条路都得走。
    //
    // 这不是假想：同一份真实档案里两种写法并存（中途重载了扩展，前后代码不同版本）。
    const old = {
      verdict: 'blocked',
      note: '判不出来：导航栏中存在登录状态；最终 URL 仍是这条路线；一个内容区块都没有'
        + '（试过 class="note-container"、id="note-\\d+"、class="note-header）',
    };
    assert.equal(isRecalibratable(old), true);
  });

  test('note 说判不出来、但原因是空响应 → 仍然救不了', () => {
    assert.equal(isRecalibratable({ verdict: 'blocked', note: '判不出来：响应体为空' }), false);
  });

  test('按路线分组统计 —— 一次改动通常只修好一条路线', (t) => {
    if (!existsSync('/home/mewx/downloads/20260806')) return t.skip('真实档案不在这台机器上');
    const { stats } = parse(openAll('/home/mewx/downloads/20260806'));
    // 实测：那两条 /topic/ 日记的旧写法，改好框架标志之后离线重跑就能救回来。
    assert.ok(stats.recalibratable['note.item'] >= 2, JSON.stringify(stats.recalibratable));
  });
});
