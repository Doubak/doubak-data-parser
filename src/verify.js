/**
 * 完整性检查：**这些字节，是不是它自称的那些。**
 *
 * ## 它不是第二个 validate.py
 *
 * 规范仓库里那个参考校验器问的是「这份档案合不合规」——crawl_state 的不变量、
 * coverage 的可追溯性、schema 的形状。这里问的是一个窄得多的问题，两者不该
 * 混：合规性错误里有一部分是**永久**的（bundle 一旦产出就冻结，实测 24 份
 * 真实档案里有 4 份因为一个早已修好的生产者 bug 永远报 45 个错），而一个
 * 永远有内容的失败列表就是一个没人看的失败列表。完整性错误相反，健康的档案上
 * 恒为零。
 *
 * 所以这里**刻意不做**：schema 校验、crawl_state / coverage / enumeration 的
 * 语义、README.txt 与 checkpoint 在不在。那些是 `validate.py` 的活，重写一遍
 * 只会得到两套会漂移的说法。
 *
 * ## 为什么解析器需要这么一趟，而不是「跑一下 validate.py 就行」
 *
 * 两个实测出来的理由：
 *
 * 1. **解析器压根不打开图片行。** 一份真实档案 23962 条捕获里 6134 条是
 *    `surface: asset`，`parse()` 一条都不读。往 assets 段里翻三个字节再解析，
 *    产出与基线**逐字节相同**——坏消息要等到生成站点那一步才以一句 zlib 的
 *    栈回溯的形式冒出来，离起因隔着两个工具。
 * 2. **`validate.py` 要 Python。** 这条链路上其余每一环都是零依赖的 Node，
 *    而完整性恰恰是最该顺手跑的那一项。
 *
 * ## gunzip 与 sha256 都是注入的
 *
 * 与 `zip.js` 的压缩器同一个理由：字节从哪儿来、拿什么解压、拿什么摘要，是
 * **宿主的事**；哪些字段要对得上、对不上算什么错，只有一份实现。
 *
 * Node 那边绑 `node:zlib` 与 `node:crypto`；扩展那边绑 `DecompressionStream`
 * 与 `crypto.subtle`。这里**不用 `sha256.js`**——实测纯 JS 实现 50 MB/s，
 * `node:crypto` 2133 MB/s，差 42 倍；一份 619 MB 的档案解压出来 2 GB 正文，
 * 那是 55 秒与 1.3 秒的差别。（`sha256.js` 头注里那个「慢 4.2 倍」说的是几万次
 * 短字符串，那时候每次调用的固定开销占大头；论块吞吐差得多。）
 */

/**
 * 一条发现。
 *
 * @typedef {object} Finding
 * @property {string} bundle
 * @property {'segment_missing'|'segment_bytes'|'segment_sha256'|'index_sha256'
 *   |'index_line_count'|'record_count'|'offset_out_of_range'|'not_gzip'
 *   |'not_warc'|'record_id_mismatch'|'content_sha256'} kind
 * @property {string} message
 * @property {string} [capture]
 * @property {string} [segment]
 */

import { bodyOf, hasRecordId } from './warc.js';

/**
 * 查一份 bundle。
 *
 * @param {object} src
 * @param {string} src.bundleId
 * @param {object|null} src.manifest
 * @param {object[]} src.index
 * @param {(name: string) => Uint8Array | Promise<Uint8Array>} src.segmentBytes
 * @param {string | null} [src.indexText] index 文件的原文；没有就跳过 index 的哈希与行数
 * @param {object} host
 * @param {(bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>} host.gunzip
 * @param {(bytes: Uint8Array) => string | Promise<string>} host.sha256  返回小写十六进制
 * @param {(p: {done: number, total: number, bundle: string}) => void} [onProgress]
 * @returns {Promise<{findings: Finding[], checked: {segments: number, captures: number,
 *   bytes: number, hashed: number}}>}
 */
export async function verifyBundle(src, host, onProgress) {
  /** @type {Finding[]} */
  const findings = [];
  const checked = { segments: 0, captures: 0, bytes: 0, hashed: 0 };
  const bundle = src.bundleId;
  const add = (kind, message, extra = {}) => findings.push({ bundle, kind, message, ...extra });

  // ── ① 段文件：manifest 声明的大小与摘要
  //
  // 这一层最便宜（只读压缩后的字节），而且覆盖**全部**字节——包括解析器
  // 从不打开的那些图片行。
  /** @type {Map<string, Uint8Array>} */
  const segs = new Map();
  const load = async (name) => {
    if (!segs.has(name)) {
      try {
        segs.set(name, await src.segmentBytes(name));
      } catch (err) {
        segs.set(name, null);
        add('segment_missing', `段文件读不出来: ${name}（${err.message ?? err}）`, { segment: name });
      }
    }
    return segs.get(name);
  };

  for (const seg of src.manifest?.segments ?? []) {
    const name = seg.filename;
    const data = await load(name);
    if (!data) continue;
    checked.segments += 1;
    checked.bytes += data.length;
    if (typeof seg.bytes === 'number' && seg.bytes !== data.length) {
      add('segment_bytes', `${name}: 大小不符，manifest 记 ${seg.bytes}，实际 ${data.length}`, { segment: name });
    }
    if (seg.sha256) {
      const got = await host.sha256(data);
      checked.hashed += data.length;
      if (got !== seg.sha256) {
        add('segment_sha256', `${name}: sha256 不符\n    manifest: ${seg.sha256}\n    实际:     ${got}`, { segment: name });
      }
    }
  }

  // ── ② index 自身
  const meta = src.manifest?.index;
  if (meta && src.indexText != null) {
    if (meta.sha256) {
      const got = await host.sha256(new TextEncoder().encode(src.indexText));
      if (got !== meta.sha256) {
        add('index_sha256', `index sha256 不符\n    manifest: ${meta.sha256}\n    实际:     ${got}`);
      }
    }
    if (typeof meta.line_count === 'number' && meta.line_count !== src.index.length) {
      add('index_line_count', `index 行数不符，manifest 记 ${meta.line_count}，实际 ${src.index.length}`);
    }
  }

  // ── ③ 每段的 record_count 要等于指向它的 index 行数
  //
  // warcinfo 不是一次捕获，不进 index，也不计入 record_count。
  const perSegment = new Map();
  for (const row of src.index) {
    if (row.segment) perSegment.set(row.segment, (perSegment.get(row.segment) ?? 0) + 1);
  }
  for (const seg of src.manifest?.segments ?? []) {
    const declared = seg.record_count;
    if (declared == null) continue;
    const actual = perSegment.get(seg.filename) ?? 0;
    if (declared !== actual) {
      add('record_count', `${seg.filename}: record_count 为 ${declared}，但 index 中指向本段的行数为 ${actual}`, { segment: seg.filename });
    }
  }

  // ── ④ 逐条捕获
  let done = 0;
  for (const row of src.index) {
    onProgress?.({ done: done += 1, total: src.index.length, bundle });
    const where = `${row.capture_id} @ ${row.segment}+${row.offset}`;
    const data = await load(row.segment);
    if (!data) continue;

    if (row.offset + row.length > data.length) {
      add('offset_out_of_range', `${where}: offset+length 超出段文件长度（段 ${data.length} 字节）`, { capture: row.capture_id, segment: row.segment });
      continue;
    }

    let raw;
    try {
      raw = await host.gunzip(data.subarray(row.offset, row.offset + row.length));
    } catch (err) {
      add('not_gzip', `${where}: 这一段不是合法的 gzip member（${err.message ?? err}）`, { capture: row.capture_id, segment: row.segment });
      continue;
    }
    checked.captures += 1;

    if (!(raw[0] === 0x57 && raw[1] === 0x41 && raw[2] === 0x52 && raw[3] === 0x43)) { // "WARC"
      add('not_warc', `${where}: 解压结果不是 WARC 记录`, { capture: row.capture_id });
      continue;
    }

    // **这一条是最要紧的。** 索引与字节之间只有这一处交叉引用；偏移量整体
    // 错位一条记录时，gzip 解得开、CRC 过、正文是一个合法页面，只有它看得出来。
    if (row.warc_record_id && !hasRecordId(raw, row.warc_record_id)) {
      add('record_id_mismatch', `${where}: 这条记录不是 ${row.warc_record_id}——offset 指错了地方`, { capture: row.capture_id });
      continue;
    }

    if (!row.content_sha256) continue;
    let body;
    try {
      body = bodyOf(raw, where);
    } catch (err) {
      add('not_warc', `${where}: ${err.message ?? err}`, { capture: row.capture_id });
      continue;
    }
    const got = await host.sha256(body);
    checked.hashed += body.length;
    if (got !== row.content_sha256) {
      add('content_sha256', `${where}: content_sha256 与正文不符\n    index: ${row.content_sha256}\n    实际:  ${got}`, { capture: row.capture_id });
    }
  }

  return { findings, checked };
}

/**
 * 查一批 bundle。
 *
 * @param {object[]} sources
 * @param {object} host 见 `verifyBundle`
 * @param {(p: {done: number, total: number, bundle: string}) => void} [onProgress]
 */
export async function verifyAll(sources, host, onProgress) {
  /** @type {Finding[]} */
  const findings = [];
  const checked = { bundles: 0, segments: 0, captures: 0, bytes: 0, hashed: 0 };
  for (const src of sources) {
    const r = await verifyBundle(src, host, onProgress);
    findings.push(...r.findings);
    checked.bundles += 1;
    for (const k of ['segments', 'captures', 'bytes', 'hashed']) checked[k] += r.checked[k];
    src.close?.();
  }
  return { findings, checked };
}

/**
 * 出了问题的那些 capture_id。
 *
 * `bin/parse.js --verify` 拿它来**排除**这些捕获，而不是拒绝整份档案：
 * 一张图坏了不该让另外两万条观测也进不来（INGESTION.md §2.3——丢弃的是
 * 凭它能下的结论，不是数据）。
 *
 * @param {Finding[]} findings
 * @returns {Set<string>}
 */
export function badCaptures(findings) {
  const out = new Set();
  for (const f of findings) if (f.capture) out.add(f.capture);
  return out;
}
