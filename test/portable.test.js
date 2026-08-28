/**
 * 解析器的绝大部分要能原样跑在浏览器扩展里，所以**不许碰内建模块**。
 *
 * ## 边界在哪儿
 *
 * `bundle-source.js` 是唯一被排除的：它做的是「字节从哪儿来」，Node 读文件、
 * 扩展读 OPFS，本来就该各写各的。`parse()` 只依赖那八项契约
 * （status / manifest / bundleId / index / crawlState / coverage / payload / close），
 * 而**「字节怎么解释」只有一份实现**——那才是错了会两边一起错的部分。
 *
 * ## 为什么要一条测试守着
 *
 * 破坏它太容易了，而且失败离现场很远。往 `authority.js` 里加一行
 * `import { X } from 'node:util'` 在这个仓库里毫无问题，`npm test` 全绿；
 * 炸的地方在扩展，而且如果那是个 Worker，抛出来的 `ErrorEvent` 上什么有用
 * 信息都没有。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * 明确排除的。**只有这一个**，加第二个之前先问「它真的是宿主差异吗」——
 * 排除一个模块的代价是扩展那边要另写一份，而两份实现迟早分叉。
 */
const HOST_SPECIFIC = new Set(['bundle-source.js']);

test('src/ 下除了 bundle-source.js，没有一个文件 import node: 内建模块', async () => {
  const names = (await readdir(SRC)).filter((n) => n.endsWith('.js'));

  // **断言真的扫到了东西**——目录读空、后缀写错，这条测试都会变成空循环而永远绿。
  assert.ok(names.length >= 10, `src/ 里只找到 ${names.length} 个 .js，读错目录了`);

  const bad = [];
  for (const name of names) {
    if (HOST_SPECIFIC.has(name)) continue;
    const text = await readFile(join(SRC, name), 'utf-8');
    for (const m of text.matchAll(/from\s+'(node:[^']+)'/g)) bad.push(`${name} → ${m[1]}`);
  }
  assert.deepEqual(bad, [], `这些文件扩展要原样拿走，不能碰内建模块：\n${bad.join('\n')}`);
});

test('parse.js 顺着 import 走一圈，也没有内建模块混进来', async () => {
  // 上面那条按目录扫，这条按依赖扫。两条都要：将来 src/ 下多一个只给命令行用的
  // 文件时，按目录扫会误报，而 parse() 的依赖闭包才是扩展真正拿走的东西。
  const seen = new Set();
  const queue = [join(SRC, 'parse.js')];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = await readFile(file, 'utf-8');
    for (const m of text.matchAll(/from\s+'(\.[^']+)'/g)) queue.push(resolve(dirname(file), m[1]));
    for (const m of text.matchAll(/from\s+'(node:[^']+)'/g)) {
      assert.fail(`${file.slice(SRC.length + 1)} → ${m[1]}`);
    }
  }
  assert.ok(seen.size >= 8, `闭包只有 ${seen.size} 个文件，import 的正则大概坏了`);
});

test('parse() 是 async，而且只认那八项契约', async () => {
  // 契约写在 parse.js 的 JSDoc 里，这里钉住它不被悄悄扩大：多认一个方法，
  // 扩展那边的 OpfsBundleSource 就会少实现一个，而缺的那个只在运行时才炸。
  const text = await readFile(join(SRC, 'parse.js'), 'utf-8');
  assert.match(text, /export async function parse\(/, 'parse 必须是 async');

  const used = new Set([...text.matchAll(/\bsrc\.(\w+)/g)].map((m) => m[1]));
  const contract = new Set(['status', 'manifest', 'bundleId', 'index', 'crawlState', 'coverage', 'payload', 'close']);
  const extra = [...used].filter((k) => !contract.has(k));
  assert.deepEqual(extra, [], `parse() 用了契约之外的东西：${extra.join(', ')}`);
  assert.ok(used.size >= 6, `只看到 ${used.size} 项契约在用，正则大概坏了`);
});
