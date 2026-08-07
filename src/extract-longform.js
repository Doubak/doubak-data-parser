/**
 * 从正文页抽出日记与评论。
 *
 * ## 为什么必须抓正文页，列表页不够
 *
 * 列表页上的正文是**截断的摘要**——真实页面上以 `number=xxx...` 和
 * `我之前标记了，然后跑很...` 结尾。全文只在正文页里。
 *
 * ## 日记与评论的结构差得很远
 *
 * |  | 日记 | 评论 |
 * |---|---|---|
 * | 身份 | `<div id="note-<id>">` | `<div id="review-<id>-content">` |
 * | 标题 | `<h1>` 直接是文字 | `<h1><span property="v:summary">` |
 * | 时间 | `<span class="pub-date">` | `<div class="main-meta"><span content=…>` |
 * | 评分 | 没有 | `main-title-hide` |
 * | 关联作品 | 没有 | JSON-LD 的 `itemReviewed.sameAs` |
 *
 * **这些是从真实抓取的字节里量出来的，不是从浏览器另存的页面。** 两者不一样：
 * 浏览器另存的那份跑过 JS，`<h1>` 里已经是纯文字；而抓取拿到的原始 HTML 里
 * `<h1>` 套着 `<span property="v:summary">`。照浏览器那份写选择器会在真实数据上落空。
 *
 * ## 与广播相反：长文**可以编辑**
 *
 * 所以多条修订是正常的，正是要留住的东西。广播那边多一条修订是警报。
 */

/** 剥标签，保留文字与换行。正文里的 `<br>` 是内容的一部分。 */
function bodyText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&quot;|&#34;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim() || null;
}

/**
 * @typedef {object} RawLongform
 * @property {string} id
 * @property {'note'|'review'} kind
 * @property {string|null} title
 * @property {string|null} publishedAt  秒级
 * @property {string|null} body         **全文**，不是摘要
 * @property {string|null} url
 * @property {number|null} rating       只有评论有
 * @property {string|null} subjectUrl   只有评论有
 * @property {string|null} location     只有日记有（发布地）
 */

/**
 * @param {string} html
 * @param {'note'|'review'} kind
 * @returns {RawLongform|null} 认不出来就返回 null —— **不猜**
 */
export function extractLongform(html, kind) {
  if (typeof html !== 'string') return null;
  return kind === 'note' ? note(html) : review(html);
}

function note(html) {
  const id = /<div id="note-(\d+)"/.exec(html)?.[1];
  if (!id) return null;

  // 正文的**两端都要钉死**：从 `#link-report` 起，到 `#note_<id>_footer` 止。
  //
  // 第一版没钉右端（只写「到下一个 <div class="">」），结果溢出到了页脚，把
  //
  //     1740人浏览
  //
  // 一起吞了进去。那是**浏览计数**——它每次抓取都在涨，于是同一篇日记在三次抓取里
  // 产出了三条修订，看起来像用户在 24 小时内改了两次。
  //
  // 这是这套系统最坏的一种错：**凭空捏造编辑历史**，而且它不会报错。canonical 存在
  // 的全部理由就是「这条什么时候改的」，一个溢出的正则足以让那个答案全是噪音。
  //
  // 也不要退到只抓 `<p data-page>`：那太紧了，日记里的列表与代码块会被丢掉
  // （实测 2788 字缩到 237 字）。
  //
  // 顺带：**不要抓 `#note_<id>_short`**，它在正文页上是空的、display:none——
  // 摘要那一份只在列表页渲染。
  const full = new RegExp(`id="link-report"[^>]*>([\\s\\S]*?)<div[^>]*id="note_${id}_footer"`).exec(html);

  const pub = /class="pub-date">\s*([\d-]{10}[\s\d:]{0,9})\s*([^<]*)/.exec(html);
  return {
    id,
    kind: 'note',
    title: /<h1>\s*([^<]+?)\s*<\/h1>/.exec(html)?.[1] ?? null,
    publishedAt: pub?.[1]?.trim() ?? null,
    // 发布地（「澳大利亚」）。豆瓣 2022 年后才有，早年的日记没有。
    location: pub?.[2]?.trim() || null,
    body: full ? bodyText(full[1]) : null,
    url: /data-url="(https:\/\/[^"]*\/note\/\d+\/?)"/.exec(html)?.[1] ?? null,
    rating: null,
    subjectUrl: null,
  };
}

function review(html) {
  const id = /id="review-(\d+)-content"/.exec(html)?.[1]
    ?? /id="link-report-(\d+)"/.exec(html)?.[1];
  if (!id) return null;

  const content = new RegExp(`id="link-report-${id}"[^>]*>([\\s\\S]*?)(?=<link|<style)`).exec(html);
  const rating = /main-title-hide">(\d)/.exec(html)?.[1];

  return {
    id,
    kind: 'review',
    // **原始 HTML 里 `<h1>` 套着 `<span property="v:summary">`**，不是纯文字。
    title: /property="v:summary"[^>]*>\s*([^<]+)/.exec(html)?.[1]?.trim() ?? null,
    publishedAt: /class="main-meta">\s*<span content="[\d-]+">\s*([\d:\- ]{10,19})/.exec(html)?.[1]?.trim() ?? null,
    location: null,
    body: content ? bodyText(content[1]) : null,
    url: /data-url="(https:\/\/[^"]*\/review\/\d+\/?)"/.exec(html)?.[1] ?? null,
    rating: rating ? Number(rating) : null,
    // 关联作品来自 JSON-LD。**取 `sameAs` 而不是 `url`**——后者是相对路径
    // `/subject/26425271/`，而这条评论其实是给游戏写的（`/game/26425271/`），
    // 相对路径会把媒介弄错。
    subjectUrl: /"sameAs":\s*"(https:\/\/[^"]*douban\.com\/[^"]+)"/.exec(html)?.[1] ?? null,
  };
}
