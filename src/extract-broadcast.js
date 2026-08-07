/**
 * 从广播时间线抽出一条条广播。
 *
 * ## 广播与标记是两种东西
 *
 * | | 标记 | 广播 |
 * |---|---|---|
 * | 可编辑 | **可以** —— 状态、评分、短评都会变 | **不可以**，发布即冻结 |
 * | 可删除 | 可以 | 可以，而且**不留痕迹** |
 * | 时间精度 | 只到天 | **到秒** |
 * | 身份 | data-cid（半数历史档案里没有） | `data-sid`，实测 100% 有 |
 *
 * 「发布后不可编辑」是实测确认过的，也是这条路线排在最优先的理由：每条广播都是
 * 「那一刻这句话是什么样」的带日期快照，而那是**首次抓取之前发生的编辑**唯一可能
 * 的证据来源。
 *
 * 真实例子：某条标记的「想看」短评在标记页上已经被「看过」的短评覆盖了，而广播里
 * 还在，还带着秒级时间戳。
 *
 * ## 转发进来的不是自己的
 *
 * 转发别人的广播，会把对方那条整个渲染在自己的时间线上，`data-uid` 是**原作者**。
 * 实测 3394 个 wrapper 里有 8 个是别人的。它们不该进档案主人的 canonical——
 * 与广播附图那条规则同一个判据、同一个理由。
 */

/** 一条广播的外壳。转发不是嵌套结构：豆瓣把原作者那条整个渲染成一个顶层 wrapper。 */
const WRAPPER = /<div class="new-status status-wrapper[^"]*"[^>]*>/g;

/**
 * 动作词 → 状态。
 *
 * 只映射明确对应三种标记状态的那些；其余（收藏到豆列、转发、说）**保持 null**，
 * 动作原文照存。实测分布：
 *
 *   想看 1214 · 看过 1061 · 想玩 287 · 玩过 221 · 在看 194 · 在玩 106
 *   想读 72 · 读过 36 · 听过 23 · 在读 20
 *   收藏X到豆列 61 · 转发 24 · 抽不到 27
 *
 * 「收藏图书到豆列」不是一个标记状态，硬塞进 wish/done/doing 任何一格都是编造。
 */
const ACTION_STATUS = {
  想看: 'wish', 想读: 'wish', 想听: 'wish', 想玩: 'wish',
  看过: 'done', 读过: 'done', 听过: 'done', 玩过: 'done',
  在看: 'doing', 在读: 'doing', 在听: 'doing', 在玩: 'doing',
};

/**
 * @typedef {object} RawBroadcast
 * @property {string} sid            data-sid，广播的身份
 * @property {string|null} postedAt  秒级时间戳（原始字符串）
 * @property {string|null} text      正文。实测只有 23% 的广播有——多数是纯标记动作
 * @property {string|null} action    动作原文（想看 / 收藏图书到豆列 / …）
 * @property {string|null} status    动作能明确映射到三种标记状态时才有，否则 null
 * @property {string|null} targetType data-target-type
 * @property {string|null} targetId   data-object-id
 * @property {string|null} url
 */

/**
 * @param {string} html
 * @param {string} ownerUserId  档案主人的数字 id。**必需**——没有它就分不清哪些是转发来的
 * @returns {{broadcasts: RawBroadcast[], skippedOthers: number, idless: number}}
 */
export function extractBroadcasts(html, ownerUserId) {
  if (typeof html !== 'string') return { broadcasts: [], skippedOthers: 0, idless: 0 };
  if (!ownerUserId) throw new Error('extractBroadcasts 需要 ownerUserId，否则会把别人的广播也存下来');

  const at = [];
  const re = new RegExp(WRAPPER.source, 'g');
  for (let m = re.exec(html); m; m = re.exec(html)) at.push(m.index);

  /** @type {RawBroadcast[]} */
  const broadcasts = [];
  const seen = new Set();
  let skippedOthers = 0;
  let idless = 0;

  for (let i = 0; i < at.length; i++) {
    const seg = html.slice(at[i], i + 1 < at.length ? at[i + 1] : undefined);

    const uid = /data-uid="(\d+)"/.exec(seg);
    if (!uid || uid[1] !== String(ownerUserId)) { skippedOthers += 1; continue; }

    const sid = /data-sid="(\d+)"/.exec(seg);
    if (!sid) {
      // 有时间戳却没有 sid —— 抽取器跟不上页面了。要报。
      if (/class="created_at"/.test(seg)) idless += 1;
      continue;
    }
    // 头插列表翻页会让同一条广播出现在相邻两页上。实测 3386 个 wrapper / 3382 个
    // 唯一 sid——重复是正常的，不是错误。
    if (seen.has(sid[1])) continue;
    seen.add(sid[1]);

    const action = /class="lnk-people">[^<]*<\/a>\s*([^<\s][^<]{0,6}?)\s*</.exec(seg)?.[1]?.trim() ?? null;
    const quote = /<blockquote[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/.exec(seg)?.[1] ?? null;

    broadcasts.push({
      sid: sid[1],
      // 秒级。**比标记页的日期精确**，合并同一条记录的观测时不得用低精度覆盖它。
      postedAt: /class="created_at"[^>]*title="([^"]+)"/.exec(seg)?.[1] ?? null,
      // 正文原样保留，只把标签剥掉——里面常有链接（`douc.cc` 短链）与表情。
      text: quote ? stripTags(quote) : null,
      action,
      status: action ? (ACTION_STATUS[action] ?? null) : null,
      targetType: /data-target-type="(\w+)"/.exec(seg)?.[1] ?? null,
      targetId: /data-object-id="(\d+)"/.exec(seg)?.[1] ?? null,
      url: /data-status-url="([^"]+)"/.exec(seg)?.[1] ?? null,
    });
  }

  return { broadcasts, skippedOthers, idless };
}

/** 剥标签，保留文字。**不做任何归一化**——空白与全半角都是内容的一部分。 */
function stripTags(s) {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .trim() || null;
}
