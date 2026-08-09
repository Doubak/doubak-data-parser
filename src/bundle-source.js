/**
 * 读一份 bundle：索引、manifest、以及按偏移量取出的载荷。
 *
 * ## 完全离线
 *
 * 这个模块（以及整个解析器）**一个网络请求都不发**。这不是自律，是可执行的判据：
 * CLAUDE.md 里那条不变量说，把所有派生数据删掉、只靠 captures 重建，必须能跑通。
 * 解析器就是那条重建路径本身。
 *
 * ## 为什么按偏移量读，而不是顺序扫整个段
 *
 * 一个真实档案的 `catalog-*.warc.gz` 有 166 MB。顺序扫要把它整个解压一遍，而我们
 * 通常只要其中几百条。索引里每一行都带 `offset` 与 `length`，直接定位到那一条
 * gzip member 解压即可——WARC 之所以每条记录单独成 member，就是为了这个。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

const SEP = '\r\n\r\n';

export class BundleSource {
  /** @param {string} dir bundle 目录 */
  constructor(dir) {
    this.dir = dir;
    const idxName = readdirSync(dir).find((f) => f.startsWith('index-') && f.endsWith('.ndjson'));
    if (!idxName) throw new Error(`${dir}: 找不到 index-*.ndjson，这不是一个 bundle`);

    /** @type {object[]} */
    this.index = readFileSync(join(dir, idxName), 'utf-8')
      .trimEnd().split('\n').filter(Boolean).map((l) => JSON.parse(l));

    const mPath = join(dir, 'manifest.json');
    /**
     * 没有 manifest 的档案**照样要能读**。
     *
     * `manifest.json` 只在收尾时写一次，所以整个抓取过程中它都不存在；被中断的
     * 档案也没有。而那些档案里 `verdict: ok` 的捕获是**真实观测**，必须照常摄取
     * ——见 canonical/INGESTION.md §2.3：丢弃的应该是「凭它能下什么结论」，
     * 不是数据本身。
     */
    this.manifest = existsSync(mPath) ? JSON.parse(readFileSync(mPath, 'utf-8')) : null;
    this.bundleId = this.manifest?.bundle_id ?? idxName.slice('index-'.length, -'.ndjson'.length);

    /** @type {Map<string, Buffer>} 段文件缓存。一个段被反复定位，读一次就够了。 */
    this._segments = new Map();
  }

  /** manifest 里的 status；没有 manifest 就是 in_progress（它确实还没收尾）。 */
  get status() {
    return this.manifest?.status ?? 'in_progress';
  }

  /** routeKey → crawl_state 那一行。没有 manifest 时是空表。 */
  get crawlState() {
    const out = new Map();
    for (const cs of this.manifest?.crawl_state ?? []) out.set(cs.route_key, cs);
    return out;
  }

  /**
   * routeKey → coverage 那一行。没有 manifest 时是空表。
   *
   * 用来**否掉**明显说不通的完整性声明，不用来授予权限（../INGESTION.md §2：
   * 豆瓣的计数有时统计于审查之前、有时之后，证明不了完整）。
   */
  get coverage() {
    const out = new Map();
    for (const c of this.manifest?.coverage ?? []) out.set(c.route_key, c);
    return out;
  }

  /**
   * 取一条捕获的 HTTP 响应正文（已解码为字符串）。
   *
   * @param {object} row index 里的一行
   * @returns {string}
   */
  payload(row) {
    if (!this._segments.has(row.segment)) {
      this._segments.set(row.segment, readFileSync(join(this.dir, row.segment)));
    }
    const seg = this._segments.get(row.segment);
    const raw = gunzipSync(seg.subarray(row.offset, row.offset + row.length));

    // WARC 记录 = WARC 头 + 空行 + 块；块 = HTTP 状态行 + 头 + 空行 + 正文。
    const headEnd = raw.indexOf(SEP);
    if (headEnd < 0) throw new Error(`${row.capture_id}: WARC 记录结构不完整`);
    const warcHead = raw.subarray(0, headEnd).toString('utf-8');
    const len = /^Content-Length: (\d+)$/m.exec(warcHead);
    if (!len) throw new Error(`${row.capture_id}: WARC 头里没有 Content-Length`);

    const block = raw.subarray(headEnd + SEP.length, headEnd + SEP.length + Number(len[1]));
    const bodyAt = block.indexOf(SEP);
    // 正文要按**字节**切。按字符切会在中文上错位——一个汉字三个字节。
    return (bodyAt < 0 ? block : block.subarray(bodyAt + SEP.length)).toString('utf-8');
  }

  /** 释放段缓存。跑完一份档案就调一次，否则 166 MB 会一直挂着。 */
  close() {
    this._segments.clear();
  }
}

/**
 * 列出一个目录下的所有 bundle。
 *
 * **顺序无关**（canonical/INGESTION.md §5.2），所以这里怎么排都行；按 bundle_id
 * 排只是为了让输出稳定、好比对。
 *
 * @param {string} root
 * @returns {BundleSource[]}
 */
export function openAll(root) {
  const out = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try {
      out.push(new BundleSource(dir));
    } catch {
      // 不是 bundle 就跳过。**读不出来不等于出错**——目录里混着别的东西很正常。
    }
  }
  return out.sort((a, b) => (a.bundleId < b.bundleId ? -1 : 1));
}
