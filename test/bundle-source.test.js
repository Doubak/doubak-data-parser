/**
 * 找档案这一步。
 *
 * 它看着只是「列一下目录」，但漏掉一份档案**没有任何声响**——产出照样是一份
 * 看起来完整的 canonical，只是少了一段历史。所以这里验的全是「会不会悄悄少读」。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openAll } from '../src/bundle-source.js';

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
