/**
 * 完整性检查。
 *
 * ## 为什么造真 bundle，而不是打桩
 *
 * 要守的性质恰恰是「gzip、WARC、index、manifest 这四样拼起来是自洽的」。
 * 把它们拆开打桩，测的就只剩下比较两个字符串了。
 *
 * ## 每一条都要变异验过
 *
 * 一条永远绿的完整性检查比没有更糟——它会让人以为查过了。所以每一条都配一份
 * 「把它弄坏，这条必须红」，而且**坏的方式要模拟真实的坏法**：
 * 位腐坏翻 CRC，生产者 bug 改成自洽的。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openAll, NODE_VERIFY_HOST } from '../src/bundle-source.js';
import { verifyAll, badCaptures } from '../src/verify.js';
import { bodyOf, hasRecordId, sepAt } from '../src/warc.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const BID = '20260830T120000Z-abc123';
const SEGMENT = `data-${BID}-00001.warc.gz`;

/**
 * 造一份真的能过检查的 bundle：真 gzip、真 WARC 记录、真 index、自洽的 manifest。
 *
 * @param {Array<{body: string|Buffer, contentType?: string}>} pages
 */
function makeBundle(pages) {
  const root = mkdtempSync(join(tmpdir(), 'doubak-verify-'));
  const dir = join(root, `doubak-bundle-${BID}`);
  mkdirSync(dir, { recursive: true });

  const chunks = [];
  const rows = [];
  let offset = 0;
  pages.forEach((p, i) => {
    const body = Buffer.from(p.body);
    const recordId = `urn:uuid:00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const http = Buffer.concat([
      Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: ${p.contentType ?? 'text/html'}\r\n\r\n`),
      body,
    ]);
    const warc = Buffer.concat([
      Buffer.from(
        `WARC/1.1\r\nWARC-Type: response\r\nWARC-Record-ID: <${recordId}>\r\n`
        + `Content-Length: ${http.length}\r\n\r\n`,
      ),
      http,
    ]);
    const gz = gzipSync(warc);
    chunks.push(gz);
    rows.push({
      capture_id: `${BID}#${String(i + 1).padStart(6, '0')}`,
      warc_record_id: recordId,
      segment: SEGMENT,
      offset,
      length: gz.length,
      url: `https://www.douban.com/p/${i}`,
      intent: 'broadcast.timeline',
      route_key: 'broadcast.timeline',
      surface: 'html',
      verdict: 'ok',
      capture_fidelity: 'decoded_body+observed_headers',
      observed_at: '2026-08-30T12:00:00+08:00',
      content_sha256: sha(body),
    });
    offset += gz.length;
  });

  const segBytes = Buffer.concat(chunks);
  writeFileSync(join(dir, SEGMENT), segBytes);
  const indexText = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(join(dir, `index-${BID}.ndjson`), indexText);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    spec_version: 'bundle/1.3',
    bundle_id: BID,
    status: 'complete',
    segments: [{
      filename: SEGMENT, bytes: segBytes.length, sha256: sha(segBytes), record_count: rows.length,
    }],
    index: {
      filename: `index-${BID}.ndjson`,
      sha256: sha(Buffer.from(indexText)),
      line_count: rows.length,
    },
  }, null, 2));
  return { root, dir };
}

const run = async (root) => verifyAll(openAll(root), NODE_VERIFY_HOST);

/** 改 index，并让 manifest 跟着自洽——**真实的生产者 bug 就是自洽的**。 */
function rewriteIndex(dir, mutate) {
  const idx = join(dir, `index-${BID}.ndjson`);
  const rows = readFileSync(idx, 'utf-8').trimEnd().split('\n').map((l) => JSON.parse(l));
  mutate(rows);
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(idx, text);
  const mPath = join(dir, 'manifest.json');
  // 抓到一半的档案没有 manifest，那种情况下没什么可跟着改的。
  if (!existsSync(mPath)) return;
  const m = JSON.parse(readFileSync(mPath, 'utf-8'));
  m.index.sha256 = sha(Buffer.from(text));
  m.index.line_count = rows.length;
  writeFileSync(mPath, JSON.stringify(m, null, 2));
}

const PAGES = [
  { body: '<html>第一页 中文要按字节切</html>' },
  { body: '<html>第二页</html>' },
  { body: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]), contentType: 'image/jpeg' },
];

describe('干净的档案', () => {
  test('一条发现都没有，而且**确实查了东西**', async () => {
    const { root } = makeBundle(PAGES);
    const { findings, checked } = await run(root);
    assert.deepEqual(findings, []);
    // 断言真的查了——不然一个写错的循环会让这套测试永远绿。
    assert.equal(checked.bundles, 1);
    assert.equal(checked.segments, 1);
    assert.equal(checked.captures, 3, '三条捕获都要真的解压过');
    assert.ok(checked.hashed > 0, '摘要必须真的算过');
  });

  test('**二进制正文也过**', async () => {
    // 这一条是这套检查存在的半个理由：档案里 26% 是 JPEG，而 `payload()` 返回的是
    // 解码后的字符串——拿字符串算摘要，非法 UTF-8 会变成 U+FFFD，摘要必然对不上，
    // 而看起来像是档案坏了。所以 verify 走的是字节，`warc.js` 就是为此抽出来的。
    const { root } = makeBundle([{
      body: Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x81, 0xc0]), contentType: 'image/jpeg',
    }]);
    const { findings } = await run(root);
    assert.deepEqual(findings, [], '任何一条都不该报——这些字节本来就不是 UTF-8');
  });
});

describe('段级', () => {
  test('段文件字节腐坏 → segment_sha256', async () => {
    const { root, dir } = makeBundle(PAGES);
    const seg = join(dir, SEGMENT);
    const bytes = readFileSync(seg);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    writeFileSync(seg, bytes);
    const { findings } = await run(root);
    assert.ok(findings.some((f) => f.kind === 'segment_sha256'), '段哈希必须报');
  });

  test('段文件被截断 → segment_bytes', async () => {
    const { root, dir } = makeBundle(PAGES);
    const seg = join(dir, SEGMENT);
    writeFileSync(seg, readFileSync(seg).subarray(0, 20));
    const { findings } = await run(root);
    assert.ok(findings.some((f) => f.kind === 'segment_bytes'));
  });

  test('record_count 与索引行数对不上', async () => {
    const { root, dir } = makeBundle(PAGES);
    const mPath = join(dir, 'manifest.json');
    const m = JSON.parse(readFileSync(mPath, 'utf-8'));
    m.segments[0].record_count = 99;
    writeFileSync(mPath, JSON.stringify(m, null, 2));
    const { findings } = await run(root);
    assert.ok(findings.some((f) => f.kind === 'record_count'));
  });

  test('index 行数与 manifest 声明的对不上', async () => {
    const { root, dir } = makeBundle(PAGES);
    const mPath = join(dir, 'manifest.json');
    const m = JSON.parse(readFileSync(mPath, 'utf-8'));
    m.index.line_count = 99;
    writeFileSync(mPath, JSON.stringify(m, null, 2));
    const { findings } = await run(root);
    assert.ok(findings.some((f) => f.kind === 'index_line_count'));
  });
});

describe('捕获级', () => {
  test('**offset 整体错位一条记录 → record_id_mismatch**', async () => {
    // 这是最要紧的一条，也是最不显眼的：段哈希对得上（字节没动）、gzip 解得开、
    // CRC 也过、正文还是一个合法页面。索引与字节之间只有 warc_record_id 这一处
    // 交叉引用，除了它谁也看不出来指错了地方。
    //
    // 实测把一份真实档案的 offset 前移一条：解析器只报了
    // `status_mismatch: 93`，读起来像抽取器坏了——归因完全错。
    const { root, dir } = makeBundle(PAGES);
    rewriteIndex(dir, (rows) => {
      const orig = rows.map((r) => ({ o: r.offset, l: r.length }));
      for (let i = 1; i < rows.length; i += 1) {
        rows[i].offset = orig[i - 1].o;
        rows[i].length = orig[i - 1].l;
      }
    });
    const { findings } = await run(root);
    const hit = findings.filter((f) => f.kind === 'record_id_mismatch');
    assert.equal(hit.length, 2, '被挪过的那两条都要报');
    assert.ok(hit[0].capture, '必须点名到具体的捕获');
  });

  test('自洽的生产者 bug：content_sha256 与正文不符', async () => {
    // 段没动、manifest 里 index 的哈希已经改成与篡改后的索引一致，所以段哈希、
    // gzip CRC、行数、记录 id 全都对得上。实测 `validate.py` 在加这条检查之前
    // 对这种档案一句话都不说。
    const { root, dir } = makeBundle(PAGES);
    rewriteIndex(dir, (rows) => {
      rows[1].content_sha256 = sha(Buffer.from('另外一个页面'));
    });
    const { findings } = await run(root);
    const hit = findings.filter((f) => f.kind === 'content_sha256');
    assert.equal(hit.length, 1);
    assert.equal(hit[0].capture, `${BID}#000002`);
  });

  test('offset 超出段文件 → offset_out_of_range，而且不往下崩', async () => {
    const { root, dir } = makeBundle(PAGES);
    rewriteIndex(dir, (rows) => { rows[0].offset = 10 ** 9; });
    const { findings } = await run(root);
    assert.ok(findings.some((f) => f.kind === 'offset_out_of_range'));
  });

  test('offset 指到不是 gzip 的地方 → not_gzip', async () => {
    const { root, dir } = makeBundle(PAGES);
    rewriteIndex(dir, (rows) => { rows[0].offset += 3; });
    const { findings } = await run(root);
    assert.ok(findings.some((f) => f.kind === 'not_gzip' || f.kind === 'not_warc'));
  });
});

describe('没有 manifest 的档案', () => {
  test('**照查不误，只是段级那几条查不了**', async () => {
    // 抓到一半的档案就没有 manifest（它只在收尾时写一次）。整个拒查是错的：
    // 那份档案里 verdict=ok 的捕获是真实观测，而逐条的 content_sha256 与
    // warc_record_id 全都还在索引里，照样核得动。
    const { root, dir } = makeBundle(PAGES);
    rmSync(join(dir, 'manifest.json'));

    const clean = await run(root);
    assert.deepEqual(clean.findings, []);
    assert.equal(clean.checked.captures, 3, '没有 manifest 也要逐条核过');
    assert.equal(clean.checked.segments, 0, '段级那几条确实查不了');

    // 而且坏掉照样抓得到——不是因为「没 manifest 就全放行」才绿的。
    rewriteIndex(dir, (rows) => { rows[0].content_sha256 = sha(Buffer.from('别的')); });
    const dirty = await run(root);
    assert.ok(dirty.findings.some((f) => f.kind === 'content_sha256'));
  });
});

describe('badCaptures', () => {
  test('只收点得到名的那些 —— 段级的问题不该连坐所有捕获', async () => {
    const { root, dir } = makeBundle(PAGES);
    rewriteIndex(dir, (rows) => { rows[2].content_sha256 = sha(Buffer.from('x')); });
    const { findings } = await run(root);
    assert.deepEqual([...badCaptures(findings)], [`${BID}#000003`]);
  });
});

describe('warc.js 本身', () => {
  test('bodyOf 切出来的就是原始字节，中文与二进制都不错位', () => {
    const body = Buffer.from('中文正文 🎬');
    const http = Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\nX: 1\r\n\r\n'), body]);
    const warc = Buffer.concat([
      Buffer.from(`WARC/1.1\r\nWARC-Record-ID: <urn:uuid:x>\r\nContent-Length: ${http.length}\r\n\r\n`),
      http,
    ]);
    assert.deepEqual(Buffer.from(bodyOf(warc)), body);
  });

  test('**记录 id 只在头里找**', () => {
    // 正文里出现同样的字符串不算数——那是页面内容。不设这条界限的话，一个
    // 引用了别处记录 id 的页面会让错位检查失效，而且是静默失效。
    const id = 'urn:uuid:aaaa';
    const body = Buffer.from(`<html>正文里写着 <${id}> 这几个字</html>`);
    const http = Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\n\r\n'), body]);
    const warc = Buffer.concat([
      Buffer.from(`WARC/1.1\r\nWARC-Record-ID: <urn:uuid:bbbb>\r\nContent-Length: ${http.length}\r\n\r\n`),
      http,
    ]);
    assert.equal(hasRecordId(warc, 'urn:uuid:bbbb'), true);
    assert.equal(hasRecordId(warc, id), false, '正文里的那个不算');
  });

  test('sepAt 找得到结尾处的分隔符', () => {
    const b = Buffer.from('ab\r\n\r\n');
    assert.equal(sepAt(b), 2);
    assert.equal(sepAt(Buffer.from('abcd')), -1);
  });

  test('gunzip 之后确实是我们造的那条记录（夹具自检）', () => {
    const { dir } = makeBundle(PAGES);
    const seg = readFileSync(join(dir, SEGMENT));
    const rows = readFileSync(join(dir, `index-${BID}.ndjson`), 'utf-8')
      .trimEnd().split('\n').map((l) => JSON.parse(l));
    const raw = gunzipSync(seg.subarray(rows[0].offset, rows[0].offset + rows[0].length));
    assert.equal(sha(Buffer.from(bodyOf(raw))), rows[0].content_sha256);
  });
});
