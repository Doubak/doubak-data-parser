/**
 * 从作品详情页里抽东西。
 *
 * ## 这些页面此前一张都没被解析过
 *
 * 作品记录一直是从**列表页**攒出来的（标题、封面缩略图、那行没拆的元信息），
 * 而 2925 张详情页抓下来之后就躺在档案里没人读。`aliases` 字段早就在 schema 里，
 * 值却一直硬编码成 `null`。
 *
 * ## 为什么先做「又名」
 *
 * 因为它是**搜索时最有用、而别处又完全拿不到**的一项。实测抽查：
 *
 *     电影  150 张里 144 张有（96%）
 *     音乐  150 张里  73 张有（49%）
 *     书 / 游戏 / 舞台剧  0 —— 这几类页面上根本没有这一栏
 *
 * 而它装着的正是台译名、港译名、原文名：
 *
 *     重返沉默之丘(台) / 重返鬼魅山房 / 寂静岭2真人版
 *
 * 一个记得住《重返沉默之丘》却想不起《寂静岭2》的人，在没有又名的索引里
 * 什么都搜不到。
 *
 * ## 不猜语言
 *
 * CLAUDE.md 定死的：豆瓣的又名里混着粤语、台湾译名、英文、日文与各种转写，
 * **一个语言标记都没有**。所以这里存成一个无标注的字符串数组，`lang` 一律留空。
 * 猜语言属于 enricher——它的产出带 `source` 与置信度、可以重跑；解析器的产出会被
 * 当作「页面当时就是这么说的」，在这一层猜错等于把猜测冒充成观测，而源页面消失
 * 之后两者再也分不开。
 */

/** 解 HTML 实体。**只解，不归一化**——空白与全半角都是内容的一部分。 */
function decode(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * 抽「又名」。
 *
 * 判据是 `#info` 里那个 `<span class="pl">又名:</span>`，一直读到 `<br>`。
 * **不整页搜「又名」**——实测那两个字也会出现在 `<meta>` 的描述里、以及正文
 * 别处，整页搜会把描述里顺带提到的一段当成又名存下来。
 *
 * @param {string} html
 * @returns {string[]} 没有就是空数组
 */
export function extractAliases(html) {
  if (typeof html !== 'string') return [];
  const m = /<span class="pl">\s*又名:?\s*<\/span>([\s\S]{0,600}?)<br/.exec(html);
  if (!m) return [];

  return decode(m[1].replace(/<[^>]+>/g, ''))
    .split('/')
    .map((x) => x.trim())
    // 空段丢掉。**但不去重、不排序**——顺序是豆瓣给的，而「哪个排第一」
    // 本身就是信息（通常是最通行的那个译名）。
    .filter(Boolean);
}

/**
 * 从详情页 URL 上反解 (媒介, 作品 id)。五种媒介五种形状。
 *
 * @param {string} url
 * @returns {{medium: string, id: string}|null}
 */
export function subjectRefOf(url) {
  if (typeof url !== 'string') return null;
  let m = /movie\.douban\.com\/subject\/(\d+)/.exec(url);
  if (m) return { medium: 'movie', id: m[1] };
  m = /book\.douban\.com\/subject\/(\d+)/.exec(url);
  if (m) return { medium: 'book', id: m[1] };
  m = /music\.douban\.com\/subject\/(\d+)/.exec(url);
  if (m) return { medium: 'music', id: m[1] };
  m = /douban\.com\/game\/(\d+)/.exec(url);
  if (m) return { medium: 'game', id: m[1] };
  m = /douban\.com\/location\/drama\/(\d+)/.exec(url);
  if (m) return { medium: 'drama', id: m[1] };
  return null;
}

/**
 * 详情页 → 能补进作品记录的东西。
 *
 * 目前只有又名。这个函数存在的意义是**给后续留个口子**：详情页上还有结构化的
 * 导演/编剧/主演、制片国家、语言、IMDb id ——都是列表页那行 `raw_meta` 里
 * 拆不出来的（实测电影 2090 条里出现过 43 种段数）。
 *
 * @param {string} html
 * @param {string} url
 */
export function extractSubjectDetail(html, url) {
  const ref = subjectRefOf(url);
  if (!ref) return null;
  return { ...ref, aliases: extractAliases(html) };
}
