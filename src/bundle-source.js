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

    /**
     * 同一个编号的档案还在别的哪些目录里出现过。由 `openAll` 的去重填。
     *
     * `duplicateDirs` 是被丢掉的那几份（索引是这一份的前缀，也就是同一份档案的
     * 拷贝）；`conflictingDirs` 是**同编号但索引对不上**的那几份，它们没有被丢掉，
     * 列在这里是为了让上层说出来——顶着同一个编号的两个不同东西，是人该知道的事。
     * @type {string[]}
     */
    this.duplicateDirs = [];
    /** @type {string[]} */
    this.conflictingDirs = [];

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
  return dedupe(out).sort((a, b) => (a.bundleId < b.bundleId ? -1 : 1));
}

/**
 * 一份 bundle 都没找到时，看看附近有没有 zip。
 *
 * ## 为什么解析器也要管这件事
 *
 * 扩展在 Firefox 上导出交出来的是一个 **zip**（那边没有 File System Access），
 * 而这里收的是**目录**——`bundle/1.4` 定义的档案就是目录，`bin/verify.js`、
 * `validate.py` 也都一样。所以那条路上必然隔着一步解压。
 *
 * 而用户走到这儿的时候，屏幕上只有一句「没有找到任何 bundle」：**这句话对，
 * 但它指向的下一步是错的**——他会去翻别的目录、以为导出坏了，而真正要做的只是
 * 解压。与扩展那边的 `describeNoBundles` 是同一条判据、同一句话；两处都要说，
 * 因为用户从哪一头撞上来都有可能。
 *
 * 只在**一份都没找到**时才去看，而且只看一层：这是一条线索，不是一次搜索。
 *
 * @param {string} root
 * @returns {string[]} 文件名
 */
export function zipsIn(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.zip$/i.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * 同一份档案被放在两个目录里时，只读一遍。
 *
 * ## 这不是假想
 *
 * 实测 `~/downloads/exports/`：`doubak-bundle-20260801T005010Z-3eef52` 在顶层
 * 和 `20260806/` 下各有一份，**逐字节相同**。`seen` 是按目录 realpath 去重的
 * （它挡的是软链接和重复进入），两个真实存在的不同目录当然都过得去，于是
 * `openAll` 返回 27 个源、26 个编号。
 *
 * ## 症状：记录全对，出处全假
 *
 * 合并是并集，所以**产出的记录一条不多一条不少**——2964 条标记、3423 条广播、
 * 修订数分毫不差。错的是出处：
 *
 * ```
 *                 含重复     去掉后
 * 起点             7（3eef52 列了两次）  6
 * 档案             27 份      26 份
 * 观测             47646      41327
 * 同一个 bundle 在一条修订里记了两次   标记 2933 · 作品 2933 · 广播 3188
 * ```
 *
 * `capture_ids` 是这份档案「指回 WARC」的那根线，也是 canonical 唯一的凭据。
 * 多出来的那条 observation 说的是「这个 bundle 又看见了它一次」——而它只看见过
 * 一次，多出来的那次是一个文件同时躺在两个文件夹里造出来的。**没有任何一处会
 * 报错**，因为记录数是对的；只有去数出处才看得见。
 *
 * ## 为什么是去重，而不是拒绝这个目录
 *
 * 与「递归进子目录」「一个目录十份档案」是同一条理由：要求人先手工摊平，换来的
 * 只会是漏掉一份。而复制一个文件夹恰恰是人会做的事——解压两遍、整理前先备份、
 * 把两次导出堆在一起。**递归让这件事更容易发生，不是更少。**
 *
 * ## 判据：索引是不是前缀
 *
 * 索引在抓取过程中是**只追加**的，导出只是把文件拷走。所以「早一次导出」的索引
 * 一定是「晚一次导出」的**前缀**——逐字节相同是它的特例。于是：
 *
 * - 是前缀 → 同一份档案的一份（可能更旧的）拷贝，丢掉，记在 `duplicateDirs` 上；
 * - 不是前缀 → 两个不同的东西顶着同一个编号，**都留着**（并集仍然是安全的），
 *   记在 `conflictingDirs` 上让上层说出来。丢掉其中一个才是不安全的方向——
 *   那会静默丢数据，而这里的全部代价只是重复的出处又回来了。
 *
 * 留哪一份：行多的优先（前缀关系里它是超集），再看谁配得上 manifest（完整性
 * 证据在那儿），最后按目录名——**排序必须是全序**，否则同一个目录解析两次会
 * 得到不同的 `capture_ids`，而那正是这个函数在修的毛病。
 *
 * @param {BundleSource[]} sources
 * @returns {BundleSource[]}
 */
export function dedupe(sources) {
  /** @type {Map<string, BundleSource[]>} */
  const byId = new Map();
  for (const s of sources) {
    if (!byId.has(s.bundleId)) byId.set(s.bundleId, []);
    byId.get(s.bundleId).push(s);
  }

  const kept = [];
  for (const group of byId.values()) {
    if (group.length === 1) { kept.push(group[0]); continue; }

    const ranked = [...group].sort((a, b) => (
      b.index.length - a.index.length
      || (b.manifest ? 1 : 0) - (a.manifest ? 1 : 0)
      || (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0)
    ));
    const [primary, ...rest] = ranked;
    for (const s of rest) {
      if (primary.indexText.startsWith(s.indexText)) {
        primary.duplicateDirs.push(s.dir);
        s.close();
      } else {
        primary.conflictingDirs.push(s.dir);
        kept.push(s);
      }
    }
    kept.push(primary);
  }
  return kept;
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
