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

import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { bodyOf, decodeBody } from './warc.js';

/**
 * 交给 `verify.js` 的宿主能力：解压与摘要。
 *
 * **摘要用 `node:crypto`，不用 `sha256.js`。** 后者是为了「同一份代码两处都能跑」
 * 才手写的，代价实测是 50 MB/s 对 2133 MB/s；完整性检查要摘的是整份档案解压后的
 * 全部正文（一份真实档案 2 GB），差的是 55 秒与 1.3 秒。摘要在这里不参与任何
 * 跨宿主的语义，所以各用各的最快实现是对的。
 */
export const NODE_VERIFY_HOST = {
  gunzip: (bytes) => gunzipSync(bytes),
  sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
};

/** 一个目录里所有的 `index-*.ndjson`，排过序（好让产出稳定）。 */
export function indexFilesIn(dir) {
  return readdirSync(dir)
    .filter((f) => f.startsWith('index-') && f.endsWith('.ndjson'))
    .sort();
}

export class BundleSource {
  /**
   * @param {string} dir bundle 目录
   * @param {string} [idxName] 用哪一份索引。**一个目录里混着好几份档案时必须指名**
   *   ——不指名就只能靠「按文件名排第一个」，而那与 `manifest.json` 是谁的毫无关系。
   */
  constructor(dir, idxName = undefined) {
    this.dir = dir;
    if (idxName === undefined) {
      const found = indexFilesIn(dir);
      if (found.length === 0) throw new Error(`${dir}: 找不到 index-*.ndjson，这不是一个 bundle`);
      // 只有一份时行为与从前完全一样；多份时由 `openAll` 逐份指名。
      [idxName] = found;
    }

    /**
     * index 文件的原文。
     *
     * 留着是给 `verify.js` 核 manifest 里那个 sha256 用的——**必须是原始字节，
     * 不能拿解析后的行重新拼**。重新拼出来的文本在键序、空白、尾随换行上都可能
     * 与盘上那份不同，于是哈希对不上，而看起来像是档案坏了。
     */
    this.indexText = readFileSync(join(dir, idxName), 'utf-8');
    /** @type {object[]} */
    this.index = this.indexText.trimEnd().split('\n').filter(Boolean).map((l) => JSON.parse(l));

    const mPath = join(dir, 'manifest.json');
    /**
     * 没有 manifest 的档案**照样要能读**。
     *
     * `manifest.json` 只在收尾时写一次，所以整个抓取过程中它都不存在；被中断的
     * 档案也没有。而那些档案里 `verdict: ok` 的捕获是**真实观测**，必须照常摄取
     * ——见 canonical/INGESTION.md §2.3：丢弃的应该是「凭它能下什么结论」，
     * 不是数据本身。
     */
    const manifest = existsSync(mPath) ? JSON.parse(readFileSync(mPath, 'utf-8')) : null;

    /**
     * **编号取自索引文件名，不取自 manifest。**
     *
     * 原来是反过来的（`manifest?.bundle_id ?? 文件名`），而那在一个目录里混着
     * 好几份档案时会造出一份**自相矛盾**的源：实测 `~/downloads/old` 里躺着 10 份
     * 档案的文件和 1 份 manifest，读出来是「manifest.bundle_id = 786e5c，
     * index 第一行 = 20260730T102904Z-f4ef8c#000001」——一份档案的清单配了另一份
     * 档案的索引，而且一声不吭。
     *
     * 索引文件名与它里面每一行的 `capture_id` 前缀是同源的，所以它才是这份数据
     * 自己的身份。manifest 是一份**关于某个编号**的说明，对不上就说明它说的不是
     * 这一份。
     */
    this.bundleId = idxName.slice('index-'.length, -'.ndjson'.length);

    /**
     * manifest 只有在确实说的是这一份时才认。
     *
     * 认错的代价不是少点信息，是 `crawl_state` / `coverage` 会被当成这份档案的
     * 完整性证据用（`absenceAuthority`）——拿另一份档案的水位线去判断「这里缺的
     * 就是删掉的」，得到的结论是错的，而且看不出来。**不认它只是少granted 一些
     * 权限，那个方向是安全的。**
     */
    this.manifest = manifest && (!manifest.bundle_id || manifest.bundle_id === this.bundleId)
      ? manifest : null;
    /** manifest 在，但说的是别人。留着给上层报告用。 */
    this.foreignManifest = manifest && manifest.bundle_id && manifest.bundle_id !== this.bundleId
      ? manifest.bundle_id : null;

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
    const raw = gunzipSync(this.segmentBytes(row.segment)
      .subarray(row.offset, row.offset + row.length));
    // 拆记录的规则在 `warc.js` 里，与 `verify.js` 同一份。**这里只负责解码。**
    // 抽出去的理由见那个文件：verify 要的是字节，而档案里 26% 的捕获是 JPEG，
    // 解码成字符串之后再编码回来已经不是原来那些字节了。
    return decodeBody(bodyOf(raw, row.capture_id));
  }

  /**
   * 一个段文件的全部字节。
   *
   * `verify.js` 要的第九项，也是**唯一**一项——它自己按 offset/length 切记录，
   * 所以不需要把 `payload()` 那八项契约撑大。`parse()` 那边一个字都没动。
   *
   * @param {string} name @returns {Buffer}
   */
  segmentBytes(name) {
    if (!this._segments.has(name)) {
      this._segments.set(name, readFileSync(join(this.dir, name)));
    }
    return this._segments.get(name);
  }

  /** 释放段缓存。跑完一份档案就调一次，否则 166 MB 会一直挂着。 */
  close() {
    this._segments.clear();
  }
}

/**
 * 列出一棵目录树下的所有 bundle，**含子目录**。
 *
 * 递归是因为真实的下载目录就是那样：解压出来的档案带一层外壳、按月份分了文件夹、
 * 或者干脆几次导出堆在一起。让人先手工摊平，只会换来「摊漏了一份」——
 * 而漏一份档案没有任何声响，产出照样是一份看着完整的 canonical。
 *
 * 两条边界：
 *
 * - **一个目录一旦认出是 bundle，就不再往里走。** 里面是段文件和索引，
 *   不会再套一份档案；继续下钻只是白读。
 * - **不跟软链接走，而且同一个真实路径只进一次。** 一个指回上层的软链接
 *   足以让递归转不出来，而这种目录结构在下载目录里并不罕见。
 *
 * **顺序无关**（canonical/INGESTION.md §5.2），所以这里怎么排都行；按 bundle_id
 * 排只是为了让输出稳定、好比对。
 *
 * @param {string} root
 * @returns {BundleSource[]}
 */
export function openAll(root) {
  const out = [];
  const seen = new Set();

  const walk = (dir) => {
    let real;
    try {
      real = realpathSync(dir);
    } catch {
      return; // 断掉的软链接、没权限：跳过，不是错
    }
    if (seen.has(real)) return;
    seen.add(real);

    // **一个目录里有几份索引，就是几份档案。**
    //
    // 原来这里只取第一份，于是 `~/downloads/old` 那样的目录——真实存在，是个
    // 下载文件夹，里头躺着 10 份档案的文件加一堆截图——被读成 **1 份**，
    // 另外 9 份（573 条捕获）一声不吭地没了。而漏一份档案没有任何声响：
    // 产出照样是一份看着完整的 canonical。
    //
    // 不拒绝、而是**逐份读出来**，理由与「递归进子目录」是同一条：要求人先手工
    // 摊平，换来的只会是「摊漏了一份」。段文件名里嵌着 bundle_id、索引每一行都
    // 写明自己指向哪个段，所以这里没有一处需要猜。
    let names = [];
    try {
      names = indexFilesIn(dir);
    } catch {
      return; // 读不了这个目录
    }
    if (names.length) {
      for (const name of names) {
        try {
          out.push(new BundleSource(dir, name));
        } catch {
          // 单独一份读不出来不该连累同目录的其他几份。
        }
      }
      return; // 是（至少一份）bundle 了，里面没有更深的档案
    }

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      // `isDirectory()` 对软链接是 false，所以这一句同时挡掉了跟着软链接走。
      if (e.isDirectory()) walk(join(dir, e.name));
    }
  };

  walk(root);
  return out.sort((a, b) => (a.bundleId < b.bundleId ? -1 : 1));
}

/**
 * 哪些目录里塞了不止一份档案。
 *
 * **能读出来不等于该这么放。** 一个目录一份档案是这个格式的假设：`manifest.json`
 * 只有一个名字，`README.txt` 也只有一份。混在一起时其中至多一份能配上它的
 * manifest，其余的完整性证据（`crawl_state` / `coverage`）就都没有了——
 * 数据还在，能下的结论少了。所以要报出来，让人有机会把它们分开。
 *
 * @param {BundleSource[]} sources
 * @returns {Array<{dir: string, bundles: string[], withManifest: string[], foreign: string[]}>}
 */
export function crowdedDirs(sources) {
  /** @type {Map<string, BundleSource[]>} */
  const byDir = new Map();
  for (const s of sources) {
    if (!byDir.has(s.dir)) byDir.set(s.dir, []);
    byDir.get(s.dir).push(s);
  }
  const out = [];
  for (const [dir, list] of byDir) {
    if (list.length < 2) continue;
    out.push({
      dir,
      bundles: list.map((s) => s.bundleId).sort(),
      withManifest: list.filter((s) => s.manifest).map((s) => s.bundleId).sort(),
      foreign: [...new Set(list.map((s) => s.foreignManifest).filter(Boolean))].sort(),
    });
  }
  return out.sort((a, b) => (a.dir < b.dir ? -1 : 1));
}
