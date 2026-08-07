/**
 * 从标记列表页抽出一条条标记。
 *
 * 依据：canonical/FIELDS.md。**每一个选择器都是对着真实档案量出来的**，不是照着
 * 页面「看起来该是这样」写的。改这里之前先去量。
 *
 * ## 每种媒介一套，这不是可以统一的东西
 *
 * 用一套通用选择器量出来的结果是「游戏 0% 有评分、0% 有短评」——而真值是 51% 与
 * 72%。306 个评分、433 条短评差一点被静默丢掉，而所有指标看起来都正常。
 *
 * ## 成对抽，不是分别扫两遍
 *
 * 按条目容器切片，每片取第一个 id、第一个时间。分别整页扫两遍再按下标配对，
 * **没有任何机制保证两个数组等长**——实测两个方向都发生过：用户短评里贴的电影
 * 链接让书的列表多出一个 id；作品被删的孤儿游戏抽不到 id。一旦不等长，从分歧
 * 那一处起每条记录都配到了别人的日期。
 */

/** 条目容器。每种媒介不同——2023 年中电影的容器 class 变过一次，两种都要认。 */
const CONTAINER = {
  movie: /<div class="item[ "][^>]*>/g,
  music: /<div class="item[ "][^>]*>/g,
  drama: /<div class="item[ "][^>]*>/g,
  book: /<li class="subject-item">/g,
  game: /<div class="common-item">/g,
};

/**
 * 作品 id。**走 URL 形状，不走 class**——URL 是豆瓣十五年不敢动的东西（改了会让
 * 所有贴出去的链接失效），class 是表现层，说改就改。
 *
 * `/j/ilmen/thing/N/interest` 是游戏在作品被删之后唯一还剩的 id 来源：那时标题变成
 * 「未知游戏」，连 `<a>` 都没有了，而删除按钮的 data-url 还在。实测 601 条游戏
 * 标记全都有这个属性。
 */
const SUBJECT_ID = /(?:\/subject\/|douban\.com\/(?:game|app)\/|\/location\/drama\/|\/j\/ilmen\/thing\/)(\d+)/;

/** 每种媒介各自的字段选择器。只有 tags 是通用的。 */
const FIELD = {
  date: { _: /class="date"[^>]*>\s*([\d-]{8,10})/ },
  tags: { _: /class="tags">\s*标签:\s*([^<]+)/ },
  rating: {
    movie: /class="rating(\d)-t"/, music: /class="rating(\d)-t"/,
    book: /class="rating(\d)-t"/, drama: /class="rating(\d)-t"/,
    game: /data-rating="(\d)"/,
  },
  comment: {
    movie: /<span class="comment">([^<]+)/, music: /<span class="comment">([^<]+)/,
    drama: /<span class="comment">([^<]+)/,
    book: /<p class="comment[^"]*"[^>]*>\s*([^<]+)/,
    // 游戏的短评在一个**没有 class 的裸 div** 里，只能靠它在 user-operation 前面定位。
    game: /<\/div>\s*<div>([^<]{2,})<\/div>\s*<div class="user-operation"/,
  },
  raw_meta: {
    movie: /<li class="intro">([^<]+)/, music: /<li class="intro">([^<]+)/,
    drama: /<li class="intro">([^<]+)/,
    book: /<div class="pub">\s*([^<]+)/,
    game: /class="desc">\s*([^<\n]+)/,
  },
  /** 豆瓣自己的标记记录 id。游戏走 ilmen，其余走 data-cid。 */
  upstream_id: {
    movie: /data-cid="(\d+)"/, music: /data-cid="(\d+)"/,
    book: /data-cid="(\d+)"/, drama: /data-cid="(\d+)"/,
    game: /\/j\/ilmen\/thing\/(\d+)\/interest/,
  },
  title: {
    movie: /<li class="title">\s*<a[^>]*>\s*<em>([^<]+)/,
    music: /<li class="title">\s*<a[^>]*>\s*<em>([^<]+)/,
    drama: /<li class="title">\s*<a[^>]*>\s*<em>([^<]+)/,
    book: /<h2>\s*<a[^>]*title="([^"]+)"/,
    game: /class="title">\s*<a[^>]*>([^<]+)/,
  },
  cover_url: { _: /<img[^>]+src="(https:\/\/[^"]+)"/ },
  subject_url: { _: /href="(https:\/\/[^"]*(?:\/subject\/|\/game\/|\/app\/|\/location\/drama\/)\d+\/?)"/ },
};

/** 页面上 `rel="<id>:P|F|N"` 的状态编码 —— 状态的第二份来源，用于交叉校验。 */
const REL_STATUS = { P: 'done', F: 'wish', N: 'doing' };

/** @param {string} seg @param {string} medium @param {string} field */
function pick(seg, medium, field) {
  const sel = FIELD[field];
  const re = sel._ ?? sel[medium];
  if (!re) return null;
  const m = re.exec(seg);
  return m ? m[1].trim() : null;
}

/**
 * @typedef {object} RawMark
 * @property {string} subjectId
 * @property {string|null} upstreamId
 * @property {string|null} title
 * @property {string|null} date
 * @property {number|null} rating
 * @property {string|null} comment
 * @property {string[]|null} tags
 * @property {string|null} rawMeta
 * @property {string|null} coverUrl
 * @property {string|null} subjectUrl
 * @property {string|null} relStatus  页面自己说的状态，用于与路线交叉校验
 * @property {boolean} upstreamDeleted
 */

/**
 * @param {string} html
 * @param {string} medium
 * @returns {{marks: RawMark[], containers: number, idless: number}}
 *   `idless`：有时间却抽不到 id 的容器数。**非 0 说明抽取器跟不上页面了**——
 *   静默跳过等于宣布「这一页就这么多」，而那是不可检测的丢失。
 */
export function extractMarks(html, medium) {
  const cont = CONTAINER[medium];
  if (!cont || typeof html !== 'string') return { marks: [], containers: 0, idless: 0 };

  const at = [];
  const re = new RegExp(cont.source, 'g');
  for (let m = re.exec(html); m; m = re.exec(html)) at.push(m.index);

  /** @type {RawMark[]} */
  const marks = [];
  const seen = new Set();
  let idless = 0;

  for (let i = 0; i < at.length; i++) {
    const seg = html.slice(at[i], i + 1 < at.length ? at[i + 1] : undefined);
    const idm = SUBJECT_ID.exec(seg);
    const date = pick(seg, medium, 'date');

    if (!idm) {
      // 有时间没有 id：这一片是个真条目，只是我们认不出它。要数出来。
      // 没时间也没 id 的是模板/装饰——游戏页上有约 100 个 `<div class="item item-tags">`
      // 是编辑表单的 JS 模板，静静丢掉即可。
      if (date) idless += 1;
      continue;
    }
    const subjectId = idm[1];
    if (seen.has(subjectId)) continue;
    seen.add(subjectId);

    const rating = pick(seg, medium, 'rating');
    const tags = pick(seg, medium, 'tags');
    const rel = /rel="\d+:(\w)"/.exec(seg);

    marks.push({
      subjectId,
      upstreamId: pick(seg, medium, 'upstream_id'),
      title: pick(seg, medium, 'title'),
      date,
      rating: rating ? Number(rating) : null,
      comment: pick(seg, medium, 'comment'),
      tags: tags ? tags.split(/\s+/).filter(Boolean) : null,
      rawMeta: pick(seg, medium, 'raw_meta'),
      coverUrl: pick(seg, medium, 'cover_url'),
      subjectUrl: pick(seg, medium, 'subject_url'),
      relStatus: rel ? (REL_STATUS[rel[1]] ?? null) : null,
      upstreamDeleted: isTombstone(seg),
    });
  }

  return { marks, containers: at.length, idless };
}

/**
 * 这条标记的作品被豆瓣删了吗。
 *
 * ## 单看任何一个信号都不行，这是量出来的
 *
 * 拿 2933 条真实标记逐条数（占位图 / 标题「未知…」/ 没有作品链接）：
 *
 * | 占位图 | 未知… | 无链接 | 条目数 | 是什么 |
 * |---|---|---|---|---|
 * | ✗ | ✗ | ✗ | 2911 | 正常 |
 * | ✓ | ✗ | ✗ | **14** | **只是没上传海报** —— 不是墓碑 |
 * | ✓ | ✓ | ✓ | 7 | 游戏，条目被删（链接也没了） |
 * | ✓ | ✓ | ✗ | 1 | 电影，条目被删（**链接还在**） |
 *
 * 两个诱人的单一判据都错：
 *
 * - **只看占位图** → 误判 14 条只是没海报的作品
 * - **只看没有链接** → 漏掉全部电影墓碑，它们的 `/subject/N/` 链接还在
 *
 * 所以取两者的合取。代价是要匹配中文「未知…」，语言相关——但一个假阳性需要同时
 * 满足两个条件，而漏判的方向是安全的（当成普通作品，只是多存一个占位标题）。
 *
 * 原始 HTML 永远在 WARC 里，判据改了随时能重跑——这正是把捕获与解释分开的意义。
 *
 * @param {string} seg 条目容器的那一片 HTML
 */
function isTombstone(seg) {
  const img = /<img[^>]+src="(https:\/\/[^"]+)"/.exec(seg);
  // `/cuphead/` 与 `/f/` 是豆瓣的前端静态资源目录——真封面不会走那里。
  const placeholder = Boolean(img && /\/(cuphead|f)\//.test(img[1]));
  return placeholder && /未知(电影|游戏|图书|音乐|剧)/.test(seg);
}
