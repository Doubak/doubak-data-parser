/**
 * WARC 记录的拆法。**纯函数，只认字节。**
 *
 * ## 为什么单独一个文件
 *
 * 这段逻辑原来长在 `bundle-source.js` 的 `payload()` 里，而 `verify.js` 需要
 * 一模一样的一段——但它要的是**字节**，不是解码后的字符串。
 *
 * 于是有两条路：把它抄一份，或者把它抽出来。抄的那条走不通，而且走不通的
 * 方式很难看见：这份档案里 26% 的捕获是 JPEG（实测 23962 条里 6134 条是
 * `surface: asset`），`content_sha256` 摘的是原始字节，而
 * `payload()` 返回的是 `toString('utf-8')` 的结果——非法 UTF-8 字节会被换成
 * U+FFFD，再编码回去就是另外三个字节。**用字符串算出来的摘要对不上，而看起来
 * 像是档案坏了。**
 *
 * 所以是抽出来。`payload()` 现在解码这里的产出，`verify()` 直接摘这里的产出，
 * 两边拆记录的规则只有一份。
 *
 * （项目里已经有四次同样形状的抽取：`sha256.js`、`record.js`、`zip.js`、
 * `pages.js`。每一次都是把纯逻辑从一个做 I/O 的文件里搬出来。）
 */

const CR = 0x0d;
const LF = 0x0a;

/**
 * 找 `\r\n\r\n` 的位置。
 *
 * 不用 `Buffer.indexOf`：那是 Node 的东西，而这个文件要原样跑在扩展里。
 * 搜索在实践中是有界的——WARC 头与 HTTP 头都在记录开头几百字节内。
 *
 * @param {Uint8Array} b @param {number} [from]
 * @returns {number} 找不到返回 -1
 */
export function sepAt(b, from = 0) {
  for (let i = from; i + 3 < b.length; i += 1) {
    if (b[i] === CR && b[i + 1] === LF && b[i + 2] === CR && b[i + 3] === LF) return i;
  }
  return -1;
}

const SEP_LEN = 4;
const decoder = new TextDecoder('utf-8');

/**
 * 从一条解压后的 WARC response 记录里切出 HTTP 正文字节。
 *
 * 记录 = WARC 头 + 空行 + 块；块 = HTTP 状态行 + 头 + 空行 + 正文。
 * WARC 头里的 `Content-Length` 说的是**块**的长度。
 *
 * **一律按字节切。** 按字符切会在中文上错位——一个汉字三个字节。
 *
 * @param {Uint8Array} raw 解压后的整条 WARC 记录
 * @param {string} [where] 出错消息里的位置标注
 * @returns {Uint8Array}
 */
export function bodyOf(raw, where = 'WARC 记录') {
  const headEnd = sepAt(raw);
  if (headEnd < 0) throw new Error(`${where}: WARC 记录结构不完整`);
  const warcHead = decoder.decode(raw.subarray(0, headEnd));
  const len = /^Content-Length: (\d+)$/m.exec(warcHead);
  if (!len) throw new Error(`${where}: WARC 头里没有 Content-Length`);

  const blockStart = headEnd + SEP_LEN;
  const block = raw.subarray(blockStart, blockStart + Number(len[1]));
  const bodyAt = sepAt(block);
  return bodyAt < 0 ? block : block.subarray(bodyAt + SEP_LEN);
}

/**
 * WARC 头里有没有这条记录 id。
 *
 * 这是**索引与字节之间唯一的交叉引用**：offset 指过去，记录里的
 * `WARC-Record-ID` 指回来。偏移量错位一整条记录时，gzip 照样解得开、CRC 照样
 * 过、正文照样是一个合法的页面——只有这一条能看出来指错了。实测把一份真实
 * 档案的 offset 整体前移一条记录：42 行全被这一条抓到。
 *
 * @param {Uint8Array} raw @param {string} id
 */
export function hasRecordId(raw, id) {
  const needle = `<${id}>`;
  // 只在头部找。正文里出现同样的字符串不算数——那是页面内容，不是记录 id。
  const headEnd = sepAt(raw);
  const head = decoder.decode(raw.subarray(0, headEnd < 0 ? raw.length : headEnd));
  return head.includes(needle);
}

/** 把正文按 UTF-8 解码。`payload()` 用它。 @param {Uint8Array} bytes */
export function decodeBody(bytes) {
  return decoder.decode(bytes);
}
