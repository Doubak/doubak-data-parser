#!/usr/bin/env node
/**
 * 完整性检查：**这份档案的字节，是不是它自称的那些。**
 *
 *   node bin/verify.js <装着一堆 bundle 的目录>
 *
 * 与规范仓库里的 `bundle/v1/validate.py` 是**两个问题**，不是两份实现：
 * 那个问「合不合规」（crawl_state 的不变量、coverage 的可追溯性、schema 的形状），
 * 这个只问「字节对不对」。分开的理由见 `src/verify.js` 的头注，一句话是：
 * bundle 是冻结的，合规性错误里有一部分永远修不掉，混在一起这份报告就没人看了。
 *
 * 那为什么解析器这边还要有一份？两个实测出来的理由：
 *
 *   - **解析器不打开图片行。** 一份真实档案 23962 条捕获里 6134 条是图片，
 *     `parse()` 一条都不读。往 assets 段里翻三个字节再解析，产出与基线逐字节
 *     相同——坏消息要等到生成站点那一步才冒出来，而且是一句 zlib 的栈回溯。
 *   - **`validate.py` 要 Python。** 这条链路其余每一环都是零依赖的 Node。
 *
 * 退出码：0 干净，1 有发现。
 */

import { openAll, crowdedDirs, NODE_VERIFY_HOST } from '../src/bundle-source.js';
import { verifyAll } from '../src/verify.js';

const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith('--'));
const [root] = argv.filter((a) => !a.startsWith('--'));

const KNOWN = ['--quiet'];
const bad = flags.filter((f) => !KNOWN.includes(f));
if (bad.length) {
  console.error(`不认识这些开关：${bad.join(' ')}`);
  console.error(`能用的：${KNOWN.join(' / ')}`);
  process.exit(2);
}
// **不是终端就不印进度。** 那一行靠 `\r` 回车重画，管道里会变成一长串糊在一起
// 的碎片，而这个命令十有八九是被 `| tail` 或者 CI 接着的。
const quiet = flags.includes('--quiet') || !process.stderr.isTTY;

if (!root) {
  console.error('用法: node bin/verify.js <bundle 目录> [--quiet]');
  console.error('  目录**连同子目录**一起找，找到的每一份 bundle 都会查一遍');
  console.error('  --quiet  只印结论，不印进度');
  process.exit(2);
}

const sources = openAll(root);
if (sources.length === 0) {
  console.error(`${root} 下没有找到任何 bundle`);
  process.exit(1);
}

// **一个目录里塞了不止一份档案，要说出来。**
//
// 能读出来不等于该这么放：其中至多一份能配上它的 manifest，其余的
// crawl_state / coverage 就都没有了——数据还在，能下的结论少了。
function reportCrowded(sources) {
  const crowded = crowdedDirs(sources);
  if (!crowded.length) return;
  for (const c of crowded) {
    console.log(`\n⚠ ${c.dir}`);
    console.log(`   这一个目录里有 ${c.bundles.length} 份档案的文件混在一起。`);
    const without = c.bundles.filter((b) => !c.withManifest.includes(b));
    if (c.withManifest.length) {
      console.log(`   只有 ${c.withManifest.join('、')} 配得上目录里那份 manifest.json；`);
      console.log(`   另外 ${without.length} 份按「没有 manifest」处理（读得到捕获，`);
      console.log('   但没有 crawl_state / coverage，不能据此判断谁被删了）。');
    }
    console.log('   想拿全的话：按 index-<编号>.ndjson 把它们各自分到一个目录里，');
    console.log('   段文件名里就嵌着编号，照着分即可。');
  }
}

reportCrowded(sources);

const t0 = Date.now();
let lastLine = 0;
const { findings, checked } = await verifyAll(sources, NODE_VERIFY_HOST, quiet ? undefined : (p) => {
  // 一秒一次就够了。逐条刷新会把时间花在写终端上。
  const now = Date.now();
  if (now - lastLine < 1000) return;
  lastLine = now;
  process.stderr.write(`\r  ${p.bundle}  ${p.done}/${p.total}   `);
});
if (!quiet) process.stderr.write('\r' + ' '.repeat(60) + '\r');

const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;
console.log(
  `档案 ${checked.bundles} 份 · 段 ${checked.segments} 个（${mb(checked.bytes)}）`
  + ` · 捕获 ${checked.captures} 条 · 摘要 ${mb(checked.hashed)} · ${Date.now() - t0} ms`,
);

if (findings.length === 0) {
  console.log('\n✔ 完整性通过：每一个段、每一条捕获，字节都与索引对得上。');
  console.log('  注意这**不代表**这份档案合规——crawl_state / coverage 那些声明是另一件事：');
  console.log('    python3 <doubak-data-specs>/bundle/v1/validate.py <bundle 目录>');
  process.exit(0);
}

// **按类型折叠，但每一类都印全。**
//
// 一份档案坏起来通常是整段坏，几千条同一个原因；逐条刷屏会把「一共有几种毛病」
// 埋掉。但每一类里**必须点名到具体的捕获**——用户拿这个去定位一份几百 MB 的
// 档案里的一段字节，只给个数字没法动手。
const byKind = new Map();
for (const f of findings) {
  if (!byKind.has(f.kind)) byKind.set(f.kind, []);
  byKind.get(f.kind).push(f);
}

/** 每一类是什么意思、下一步做什么。**不解释的那一类原样印 JSON。** */
const EXPLAIN = {
  segment_missing: ['manifest 列出的段文件读不出来', '这份档案不完整，多半是拷贝时漏了或中断了。'],
  segment_bytes: ['段文件大小与 manifest 声明的不符', '拷贝被截断，或者写到一半断了。重新拷一份。'],
  segment_sha256: ['段文件的内容变了', '字节腐坏或被改过。重抓没有用，拿原始拷贝重来。'],
  index_sha256: ['index 文件的内容与 manifest 声明的不符', '索引被改过或被截断。'],
  index_line_count: ['index 行数与 manifest 声明的不符', '导出/拷贝被截断。'],
  record_count: ['段的 record_count 与指向它的索引行数不符', '生产者的记账错了；数据可能没丢，但账对不上。'],
  offset_out_of_range: ['索引里的 offset+length 超出了段文件', '索引与段文件不是同一批产出的。'],
  not_gzip: ['offset 处不是一个能解压的 gzip member', '这几条捕获的字节坏了，取不出来。'],
  not_warc: ['解压出来的不是一条完整的 WARC 记录', '记录结构坏了。'],
  record_id_mismatch: [
    'offset 指到了别的记录上',
    '**索引与字节整体错位。** gzip 解得开、正文也是合法页面，所以除了这一条谁也看不出来——'
    + '按索引读会把 A 页的内容当成 B 页的。这份档案不能拿去解析。',
  ],
  content_sha256: [
    '正文与索引里记的摘要对不上',
    '记录 id 对得上、gzip 也解得开，但正文不是当初摘要的那一段——写字节与算摘要之间出了岔子。',
  ],
};

console.log(`\n✖ ${findings.length} 处发现，分 ${byKind.size} 类：\n`);
for (const [kind, list] of byKind) {
  const [what, next] = EXPLAIN[kind] ?? [];
  // **没解释过的类型一条一条原样印。** 折进一个「其他」桶里就看不见了，
  // 而难看的输出才有人看。
  if (!what) {
    console.log(`【${kind}】${list.length} 处（这个类型还没有人给它写过说明）`);
    for (const f of list) console.log('   ' + JSON.stringify(f));
    console.log();
    continue;
  }
  console.log(`【${kind}】${list.length} 处 —— ${what}`);
  for (const f of list.slice(0, 5)) {
    console.log(`   ${f.bundle}`);
    console.log(`     ${f.message.replace(/\n/g, '\n     ')}`);
  }
  if (list.length > 5) console.log(`   …另有 ${list.length - 5} 处`);
  console.log(`   → ${next}`);
  console.log();
}

console.log('要照常解析、只把这几条排除掉的话：');
console.log('  node bin/parse.js <目录> [输出目录] --verify');
process.exit(1);
