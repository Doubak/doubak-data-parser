/**
 * 找档案这一步。
 *
 * 它看着只是「列一下目录」，但漏掉一份档案**没有任何声响**——产出照样是一份
 * 看起来完整的 canonical，只是少了一段历史。所以这里验的全是「会不会悄悄少读」。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openAll, crowdedDirs } from '../src/bundle-source.js';

/** 造一份最小的 bundle：认它的唯一条件是有 `index-*.ndjson`。 */
function bundle(parent, id) {
  const dir = join(parent, `doubak-bundle-${id}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `index-${id}.ndjson`), '');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ bundle_id: id }));
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
