/**
 * 找档案这一步。
 *
 * 它看着只是「列一下目录」，但漏掉一份档案**没有任何声响**——产出照样是一份
 * 看起来完整的 canonical，只是少了一段历史。所以这里验的全是「会不会悄悄少读」。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openAll, crowdedDirs, dedupe, BundleSource, zipsIn } from '../src/bundle-source.js';

const BIN = new URL('../bin/parse.js', import.meta.url).pathname;

/**
 * 造一份最小的 bundle：认它的唯一条件是有 `index-*.ndjson`。
 * @param {string} parent @param {string} id
 * @param {{rows?: number, manifest?: boolean}} [opts] rows 是索引行数，manifest 默认写
 */
function bundle(parent, id, opts = {}) {
  const { rows = 0, manifest = true } = opts;
  const dir = join(parent, `doubak-bundle-${id}`);
  mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: rows }, (_, i) => JSON.stringify({
    capture_id: `${id}#${String(i + 1).padStart(6, '0')}`,
    url: `https://www.douban.com/x/${i + 1}/`,
  }));
  writeFileSync(join(dir, `index-${id}.ndjson`), lines.length ? `${lines.join('\n')}\n` : '');
  if (manifest) writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ bundle_id: id }));
  return dir;
}

/** @returns {string[]} 找到的 bundle_id，排过序 */
const idsIn = (root) => openAll(root).map((s) => s.bundleId).sort();

describe('找档案', () => {
  test('平铺在一层里的照样都找得到', () => {
    const root = mkdtempSync(join(tmpdir(), 'doubak-flat-'));
    bundle(root, 'aaa');
    bundle(root, 'bbb');
    assert.deepEqual(idsIn(root), ['aaa', 'bbb']);
    rmSync(root, { recursive: true, force: true });
  });

  test('**子目录里的也要找到**', () => {
    // 解压出来带一层外壳、按月份分了文件夹、几次导出堆在一起——真实的下载目录
    // 就长这样。要求人先手工摊平，换来的是「摊漏了一份」，而那件事不会报错。
    const root = mkdtempSync(join(tmpdir(), 'doubak-nested-'));
    bundle(root, 'top');
    const sub = join(root, '2026-08');
    mkdirSync(sub);
    bundle(sub, 'mid');
    const deep = join(sub, '解压出来的', '再一层');
    mkdirSync(deep, { recursive: true });
    bundle(deep, 'deep');
    assert.deepEqual(idsIn(root), ['deep', 'mid', 'top']);
    rmSync(root, { recursive: true, force: true });
  });

  test('认出是档案之后就不再往里钻', () => {
    // 档案里面是段文件和索引，不会再套一份档案。真钻进去的话，一个凑巧叫
    // `index-*.ndjson` 的子目录就会被当成第二份档案读出来。
    const root = mkdtempSync(join(tmpdir(), 'doubak-nodescend-'));
    const b = bundle(root, 'outer');
    bundle(b, 'inner');
    assert.deepEqual(idsIn(root), ['outer']);
    rmSync(root, { recursive: true, force: true });
  });

  test('软链接不跟着走，指回上层也不会转不出来', () => {
    // 下载目录里出现一个指回父目录的软链接并不罕见，而递归撞上它就是死循环。
    const root = mkdtempSync(join(tmpdir(), 'doubak-link-'));
    bundle(root, 'real');
    const sub = join(root, 'sub');
    mkdirSync(sub);
    symlinkSync(root, join(sub, 'loop'), 'dir');
    assert.deepEqual(idsIn(root), ['real']);
    rmSync(root, { recursive: true, force: true });
  });

  test('目录里混着别的东西不算错', () => {
    const root = mkdtempSync(join(tmpdir(), 'doubak-junk-'));
    bundle(root, 'real');
    mkdirSync(join(root, '别的文件夹'));
    writeFileSync(join(root, '随手放的.txt'), 'hi');
    assert.deepEqual(idsIn(root), ['real']);
    rmSync(root, { recursive: true, force: true });
  });

  test('一份都没有就是空数组，不是抛错', () => {
    const root = mkdtempSync(join(tmpdir(), 'doubak-none-'));
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    assert.deepEqual(openAll(root), []);
    rmSync(root, { recursive: true, force: true });
  });

  test('根目录不存在也不抛，交给上层去说话', () => {
    // bin/parse.js 会印「没找到任何 bundle」并以 1 退出，那句话比一个栈回溯有用。
    assert.deepEqual(openAll(join(tmpdir(), 'doubak-这个目录不存在-xyz')), []);
  });
});

describe('一个目录里塞了好几份档案', () => {
  /**
   * 造一个「下载文件夹」：N 份档案的索引与段文件平铺在一起，外加一份
   * 只属于其中一份的 manifest.json。
   *
   * 这不是假想的形状——`~/downloads/old` 就长这样：10 份档案的文件、1 份
   * manifest、还有一堆截图和存下来的网页。
   */
  function pile(ids, manifestFor) {
    const dir = mkdtempSync(join(tmpdir(), 'doubak-pile-'));
    for (const id of ids) {
      writeFileSync(join(dir, `index-${id}.ndjson`),
        JSON.stringify({ capture_id: `${id}#000001`, segment: `data-${id}-00001.warc.gz` }) + '\n');
      writeFileSync(join(dir, `data-${id}-00001.warc.gz`), '');
    }
    if (manifestFor) {
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ bundle_id: manifestFor }));
    }
    writeFileSync(join(dir, 'Screenshot 2026-08-02.png'), '');
    return dir;
  }

  test('**有几份索引就是几份档案** —— 原来只读第一份，另外的一声不吭地没了', () => {
    const root = pile(['20260730T102904Z-f4ef8c', '20260731T051333Z-786e5c'], '20260731T051333Z-786e5c');
    assert.deepEqual(idsIn(root), ['20260730T102904Z-f4ef8c', '20260731T051333Z-786e5c']);
    rmSync(root, { recursive: true, force: true });
  });

  test('**编号取自索引文件名，不取自 manifest**', () => {
    // 原来是 `manifest?.bundle_id ?? 文件名`，于是混放时读出来的是一份自相矛盾的
    // 源：manifest 说 786e5c，index 第一行的 capture_id 却是 f4ef8c#000001。
    const root = pile(['20260730T102904Z-f4ef8c'], '20260731T051333Z-786e5c');
    const [s] = openAll(root);
    assert.equal(s.bundleId, '20260730T102904Z-f4ef8c');
    assert.equal(
      s.index[0].capture_id.startsWith(s.bundleId), true,
      'bundleId 必须与索引里的 capture_id 前缀同源',
    );
    rmSync(root, { recursive: true, force: true });
  });

  test('**manifest 说的不是这一份就不认它**', () => {
    // 认错的代价不是少点信息：crawl_state / coverage 会被 absenceAuthority 当成
    // 这份档案的完整性证据用，拿另一份的水位线去判断「缺的就是删掉的」。
    // 不认它只是少授予一些权限，那个方向是安全的。
    const root = pile(['20260730T102904Z-f4ef8c'], '20260731T051333Z-786e5c');
    const [s] = openAll(root);
    assert.equal(s.manifest, null, '不是自己的 manifest 不能认');
    assert.equal(s.foreignManifest, '20260731T051333Z-786e5c', '但要留下线索给上层报告');
    rmSync(root, { recursive: true, force: true });
  });

  test('manifest 说的就是这一份时照常认', () => {
    const root = pile(['20260731T051333Z-786e5c'], '20260731T051333Z-786e5c');
    const [s] = openAll(root);
    assert.equal(s.manifest.bundle_id, '20260731T051333Z-786e5c');
    assert.equal(s.foreignManifest, null);
    rmSync(root, { recursive: true, force: true });
  });

  test('crowdedDirs 只报真的混放了的', () => {
    const messy = pile(['aaa', 'bbb', 'ccc'], 'bbb');
    const tidy = pile(['ddd'], 'ddd');
    const root = mkdtempSync(join(tmpdir(), 'doubak-both-'));
    cpSync(messy, join(root, 'messy'), { recursive: true });
    cpSync(tidy, join(root, 'tidy'), { recursive: true });

    const c = crowdedDirs(openAll(root));
    assert.equal(c.length, 1, '干净的那个不该被报');
    assert.deepEqual(c[0].bundles, ['aaa', 'bbb', 'ccc']);
    assert.deepEqual(c[0].withManifest, ['bbb'], '只有 bbb 配得上那份 manifest');
    rmSync(root, { recursive: true, force: true });
    rmSync(messy, { recursive: true, force: true });
    rmSync(tidy, { recursive: true, force: true });
  });
});

/**
 * **同一份档案躺在两个文件夹里。**
 *
 * 实测 `~/downloads/exports/`：`…-3eef52` 在顶层和 `20260806/` 下各有一份，
 * 逐字节相同。`openAll` 原来按目录 realpath 去重（那挡的是软链接），于是两个
 * 真实存在的目录都过得去，26 份档案读成 27 个源。
 *
 * 症状是**记录全对、出处全假**：合并是并集，所以标记、广播、修订数一条不差；
 * 错的是每条记录多出一次「这个 bundle 又看见了它」——实测标记 2933 条、
 * 作品 2933 条、广播 3188 条。`capture_ids` 是 canonical 指回 WARC 的唯一凭据，
 * 而多出来的那条出处是一个文件同时躺在两个文件夹里造出来的。
 *
 * 复制文件夹恰恰是人会做的事（解压两遍、整理前先备份、两次导出堆一起），
 * 而**递归进子目录让它更容易发生，不是更少**。
 */
describe('同一份档案出现在两个目录里', () => {
  test('逐字节相同的两份，只读一份', () => {
    const root = mkdtempSync(join(tmpdir(), 'doubak-dup-'));
    const a = bundle(root, 'same', { rows: 3 });
    mkdirSync(join(root, '备份'));
    cpSync(a, join(root, '备份', 'doubak-bundle-same'), { recursive: true });

    const sources = openAll(root);
    assert.equal(sources.length, 1, '两个目录，同一份档案，只该有一个源');
    assert.equal(sources[0].bundleId, 'same');
    assert.equal(sources[0].duplicateDirs.length, 1, '被略过的那一份要记下来，供上层说出口');
    assert.deepEqual(sources[0].conflictingDirs, [], '索引一样就不是冲突');
    rmSync(root, { recursive: true, force: true });
  });

  test('**旧的那份导出是新的前缀 —— 留行多的那个**', () => {
    // 索引在抓取过程中只追加，导出只是把文件拷走，所以早一次导出的索引一定是
    // 晚一次的前缀。留短的那份等于**静默丢掉后半段捕获**。
    const root = mkdtempSync(join(tmpdir(), 'doubak-prefix-'));
    mkdirSync(join(root, '先导的'));
    mkdirSync(join(root, '后导的'));
    bundle(join(root, '先导的'), 'grow', { rows: 2 });
    bundle(join(root, '后导的'), 'grow', { rows: 5 });

    const sources = openAll(root);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].index.length, 5, '留的必须是捕获多的那一份');
    assert.match(sources[0].dir, /后导的/);
    assert.equal(sources[0].duplicateDirs.length, 1);
    rmSync(root, { recursive: true, force: true });
  });

  test('行数一样时，配得上 manifest 的那份优先', () => {
    // manifest 里装着 crawl_state / coverage，也就是这份档案的完整性证据。
    // 两份内容一样时挑没有 manifest 的那个，等于白白少掉一整层判断依据。
    const root = mkdtempSync(join(tmpdir(), 'doubak-manifest-win-'));
    mkdirSync(join(root, 'a'));
    mkdirSync(join(root, 'b'));
    bundle(join(root, 'a'), 'same', { rows: 2, manifest: false });
    bundle(join(root, 'b'), 'same', { rows: 2, manifest: true });

    const [s] = openAll(root);
    assert.ok(s.manifest, '该留有 manifest 的那一份');
    assert.match(s.dir, /[/\\]b[/\\]/);
    rmSync(root, { recursive: true, force: true });
  });

  test('**同编号但索引对不上：两份都留着，并报出来**', () => {
    // 丢掉其中一个才是不安全的方向 —— 那会静默丢数据，而这里的全部代价只是
    // 重复的出处又回来了。方向不对称，处置就不一样。
    const root = mkdtempSync(join(tmpdir(), 'doubak-conflict-'));
    mkdirSync(join(root, 'a'));
    mkdirSync(join(root, 'b'));
    const x = bundle(join(root, 'a'), 'clash', { rows: 2 });
    bundle(join(root, 'b'), 'clash', { rows: 2 });
    // 让 b 的索引与 a 不同，且不构成前缀关系
    writeFileSync(join(root, 'b', 'doubak-bundle-clash', 'index-clash.ndjson'),
      `${JSON.stringify({ capture_id: 'clash#000009', url: 'https://example.invalid/' })}\n`);
    assert.ok(x);

    const sources = openAll(root);
    assert.equal(sources.length, 2, '对不上就都读 —— 少读一份是静默丢数据');
    const flagged = sources.filter((s) => s.conflictingDirs.length);
    assert.equal(flagged.length, 1, '冲突要记在留下的那一份上，好让上层说出来');
    rmSync(root, { recursive: true, force: true });
  });

  test('**排序必须是全序 —— 换个输入次序，留下的还是同一份**', () => {
    // 挑哪一份要是随输入次序而变，同一个目录解析两次会得出不同的 capture_ids
    // ——正是这个函数在修的那个毛病，只是换了个来源。
    //
    // **这里直接喂 dedupe，不走 openAll。** 第一版是「同一个目录 openAll 两遍」，
    // 而那条断言**永远不会红**：readdirSync 在同一个文件系统上次序稳定，
    // Array.sort 在 V8 里又是稳定排序，所以少了目录名那一档兜底也照样一致。
    // 变异验过：去掉那一行，18 条全绿。跨平台、跨文件系统时次序才会变，
    // 而那正是本机测不到的情形——所以次序得由测试自己给。
    const root = mkdtempSync(join(tmpdir(), 'doubak-stable-'));
    const dirs = ['zzz', 'aaa', 'mmm'].map((name) => {
      mkdirSync(join(root, name));
      return bundle(join(root, name), 'same', { rows: 4 });
    });
    const pick = (order) => dedupe(order.map((d) => new BundleSource(d))).map((s) => s.dir);

    assert.equal(pick(dirs).length, 1);
    assert.deepEqual(pick(dirs), pick([...dirs].reverse()), '正着喂和倒着喂必须留同一份');
    assert.deepEqual(pick(dirs), pick([dirs[1], dirs[2], dirs[0]]), '轮换一下也一样');
    rmSync(root, { recursive: true, force: true });
  });

  test('两份不同的档案不许被当成重复', () => {
    // 反方向的守卫：去重要是按目录名或按行数去判，两份**不同**的档案就会被
    // 吃掉一份，而那是真的丢数据。
    const root = mkdtempSync(join(tmpdir(), 'doubak-notdup-'));
    bundle(root, 'aaa', { rows: 3 });
    bundle(root, 'bbb', { rows: 3 });
    assert.deepEqual(idsIn(root), ['aaa', 'bbb']);
    rmSync(root, { recursive: true, force: true });
  });
});

/**
 * 一份都没找到时，要说得出下一步。
 *
 * 扩展在 Firefox 上导出交出来的是一个 zip（那边没有 File System Access），而这里
 * 收的是**目录**——`bundle/1.4` 定义的档案就是目录。所以那条路上必然隔着一步解压，
 * 而屏幕上只有「没有找到任何 bundle」的话，用户会去翻别的目录、以为导出坏了。
 *
 * 这与扩展那边的 `describeNoBundles` 是同一条判据、同一句话：**用户从哪一头撞上来
 * 都有可能**。
 */
describe('zipsIn：没找到时的那条线索', () => {
  const tmp = () => mkdtempSync(join(tmpdir(), 'doubak-zips-'));

  test('认得出 zip，且排好序', () => {
    const d = tmp();
    writeFileSync(join(d, 'doubak-archive-3eef52.zip'), '');
    writeFileSync(join(d, '照片.zip'), '');
    writeFileSync(join(d, '随手记.txt'), '');
    assert.deepEqual(zipsIn(d), ['doubak-archive-3eef52.zip', '照片.zip']);
  });

  test('大小写不敏感 —— Windows 上导出的可能是 .ZIP', () => {
    const d = tmp();
    writeFileSync(join(d, 'A.ZIP'), '');
    assert.deepEqual(zipsIn(d), ['A.ZIP']);
  });

  test('目录不算，读不了的目录返回空而不是抛', () => {
    const d = tmp();
    mkdirSync(join(d, 'x.zip')); // 一个**目录**恰好叫 x.zip
    assert.deepEqual(zipsIn(d), []);
    assert.deepEqual(zipsIn(join(d, '压根不存在')), []);
  });

  test('命令行上真的会说出来', () => {
    // 判据放在这儿而不是只测 zipsIn：那个函数返回得再对，没人把它接到那句话上
    // 也白搭——而接线断掉是静默的。
    const d = tmp();
    writeFileSync(join(d, 'doubak-archive-x.zip'), '');
    const r = spawnSync(process.execPath, [BIN, d], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /先解压/);
    assert.match(r.stderr, /doubak-archive-x\.zip/);
    assert.match(r.stderr, /doubak-bundle/, '要说清解开之后该喂哪个目录');
    assert.doesNotMatch(r.stderr, /专用格式/, '它不是 Firefox 专用格式，那句话是假的');
  });

  test('什么 zip 都没有时不许凭空多一句', () => {
    // 「一个永远有内容的提示等于没有提示」。
    const r = spawnSync(process.execPath, [BIN, tmp()], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stderr, /解压/);
  });
});
