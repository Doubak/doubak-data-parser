/**
 * 缺失推断的权限：这次观测有没有资格解释「没看见」。
 *
 * 规范：canonical/INGESTION.md §3
 *
 * ## 这是整个解析器里最要紧的三十行
 *
 * 它守的是一句话：**永远不要丢弃数据，要丢弃的是「凭这份数据能下什么结论」。**
 *
 * 被中断的抓取、只走到水位线的增量抓取，它们**看到的东西都是真的**。不真的是
 * 「它们没看到的东西不存在」。把这两件事混成「这份档案可信 / 不可信」，是这一层
 * 最主要的翻车方式，而翻车的形状是**凭空捏造删除**——不可逆，且事后无从发现。
 */

/**
 * @typedef {'whole_route' | 'above_floor' | 'none'} Authority
 */

/**
 * 算一条路线在某份档案里的权限。
 *
 * @param {object|undefined} crawlState  manifest.crawl_state 里对应的那一行
 * @param {string} bundleStatus          manifest.status
 * @returns {Authority}
 */
export function absenceAuthority(crawlState, bundleStatus) {
  // 没有 crawl_state 就没有连续性证明。没有证明就没有资格——**默认必须是 none**，
  // 不是「大概没事」。没收尾的档案走的就是这条路（它连 manifest 都还没有）。
  if (!crawlState) return 'none';

  // 一处缺口就降到 none。**不是「缺口那一段不算」**——缺口意味着我们不知道漏了
  // 什么，而漏掉的东西完全可能正好在别处。
  const clean = crawlState.contiguous === true
    && (crawlState.gaps?.length ?? 0) === 0
    && bundleStatus === 'complete';
  if (!clean) return 'none';

  if (crawlState.enumeration === 'full') return 'whole_route';

  // 增量抓取天然是 above_floor：它读到下界就停，下界以下这次压根没看。
  // 没有 floor_time 的 bounded 路线说不出「以下」是哪儿，所以也是 none。
  if (crawlState.enumeration === 'bounded' && crawlState.floor_time) return 'above_floor';

  return 'none';
}

/**
 * 这条捕获能不能当作**内容**读进来。
 *
 * ## `login` 是最危险的一种，因为它长得像好数据
 *
 * 它有内容、条目数正常、结构完整——只是公开视图。实测前代档案 2023-01 那一批
 * 105 张电影页全是匿名抓的：条目 1554 条一条不少，而**标签 0 个**（前后两批分别是
 * 945 和 1051），游戏评分同样整批消失。
 *
 * 把它们当内容读，得出的是「用户在 2023-01-27 删光了全部标签和游戏评分，年底又
 * 一条条加了回来」——四万条假编辑，每一条看起来都有据可查。
 *
 * @param {object} row index 里的一行
 * @returns {boolean}
 */
export function isContent(row) {
  return row.verdict === 'ok';
}

/**
 * 这条捕获是不是「改好抽取器就能救回来」的那一种。
 *
 * ## 为什么值得单独回答
 *
 * `verdict_reason`（bundle/1.2）把「判不出来」分成了三类处置，而其中一类是**免费的**：
 *
 *   frame_anchors_missing / not_an_image  → 页面已经在档案里，改抽取器离线重跑即可
 *   empty_body / server_error             → 得重抓
 *   其余                                   → 先看一眼
 *
 * 解析器是这个区分真正兑现的地方：它能一次扫完所有档案，回答「有多少条只要我改一行
 * 选择器就能救回来」。那正是「把捕获与解释分开」买到的东西——**知道欠了多少，而且
 * 知道不用求人重抓**。
 *
 * 旧档案（1.2 之前）没有 verdict_reason，退回读 note。档案是冻结的，两条路都得走。
 *
 * @param {object} row
 */
export function isRecalibratable(row) {
  if (row.verdict !== 'unknown' && !String(row.note ?? '').startsWith('判不出来')) return false;
  const reason = row.verdict_reason
    ?? (/一个内容区块都没有|缺少 \d+ 个页面框架标志/.test(row.note ?? '') ? 'frame_anchors_missing' : null);
  return reason === 'frame_anchors_missing' || reason === 'not_an_image';
}

/**
 * 未知的 `verdict` 取值必须当作「判不出来」。
 *
 * 封闭词表出现新取值，意味着生产者知道一种**本解析器不认识的失败方式**。把它当成
 * ok 的代价，正是这整个模块在防的那件事。这个不对称是刻意的（INGESTION.md §5.3）。
 *
 * `unknown` 是 bundle/1.2 加的，含义就是「生产者也判不出来」。它必须在这个集合里
 * ——**不然会被当成「未知取值」而多报一条告警**，而那条告警的意思是「规范跑到我
 * 前面去了」，与实际情况不符。处置本身不变：不摄取为内容、权限降为 none。
 *
 * 顺带说明这条规则为什么值得写：规范先落地、消费者再跟上（CLAUDE.md），而「跟上」
 * 具体就是这一行。漏了它，症状是一堆看不懂的告警，而不是错数据——失败方向是对的。
 */
export const KNOWN_VERDICTS = new Set([
  'ok', 'blocked', 'challenge', 'login', 'gone', 'soft404', 'unknown',
]);

/** @param {object} row */
export function hasUnknownVerdict(row) {
  return !KNOWN_VERDICTS.has(row.verdict);
}
