/**
 * **扩展里那份拷贝，是不是还是这个仓库里的这一份。**
 *
 * `doubak-extension/src/vendor/` 按字节抄着这个仓库的几个纯函数文件
 * （名单在扩展的 `tools/sync-vendor.mjs` 里）。抄一份而不是重写一份的理由写在
 * 那个脚本的抬头上，一句话是：**「字节从哪儿来」各写各的，「字节怎么解释」
 * 只能有一份。**
 *
 * ## 为什么这条检查要长在**这个**仓库里
 *
 * 扩展那边一直有 `test/vendor.test.js` 守着同一件事，而且比这里查得细。它没能
 * 拦住 2026-09-04 那次，原因不是它写得不好，是**它在改动作者到不了的那个仓库里**：
 *
 * ```
 * 09-04 19:55  doubak-extension    最后一次提交
 * 09-04 20:05  doubak-site-generator  修好「删掉再重标会把旧那条整个盖掉」
 *                                     —— 没有人再跑一次 sync-vendor
 * ```
 *
 * 于是接下来两天，命令行出的站点是修好的，而**扩展面板里「导出 → Markdown」
 * 出的站点仍然带着那个 bug**：同一个作品被标记两次时，2018 年那条的短评与标签
 * 被静默盖掉。两个宿主对同一份档案给出不同的结果，正是这套 vendor 机制存在的
 * 全部理由，而它恰好在这件事上失效了。
 *
 * 这与 2026-09-04 记下的那条是同一个形状：**每一句话都对，但做决定的人在按下去
 * 之前读不到它。** 改这个仓库的人跑的是这个仓库的 `npm test`，那就得是这里红。
 *
 * ## 跨仓库改动的顺序，以及它会红一会儿
 *
 * 两个仓库没有原子提交，所以先推的那个必然有一段时间是红的：改完这里推上去，
 * 这个仓库的 CI 红（扩展还没同步）；跟着把 `sync-vendor.mjs` 跑一遍推到扩展，
 * 两边就都绿了。**这段红是对的**——那段时间里两个宿主的行为确实不一致，
 * 而上一次同样的不一致是完全无声的，持续了两天。
 *
 * 本地缺扩展仓库时**带原因跳过**（单独 clone 这一个仓库是正常的）；
 * `CI` 里跳过等于没测，所以在 CI 里缺仓库直接判失败。这是这个项目既有的写法。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 这个仓库的根。`sync-vendor.mjs` 要拿它去读 `src/<名字>`。 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 这个仓库在扩展那份名单里叫什么。写死是故意的——见下面那条断言。 */
const REPO = 'doubak-data-parser';

/**
 * 扩展仓库在哪。**显式指了就只认那一处**——指错了地方却悄悄回退到兄弟目录，
 * 等于「你问的是 A，答的是 B，还一声不吭」，而这条检查恰恰是用来发现不一致的。
 * 它同时也是上面那条 CI 断言唯一能被变异验证的入口。
 */
const EXT = (process.env.DOUBAK_EXTENSION_DIR
  ? [process.env.DOUBAK_EXTENSION_DIR]
  : [join(ROOT, '..', 'doubak-extension')]
).find((d) => existsSync(join(d, 'tools/sync-vendor.mjs'))) ?? null;

// **名单只有一份，在扩展那边。** 这里再抄一遍文件名的话，两份名单会漂，
// 而漂的方向是「这边少列了一个」——那个文件于是没人查，正好是要防的情况。
const mod = EXT ? await import(join(EXT, 'tools/sync-vendor.mjs')) : null;
const source = mod?.SOURCES.find((s) => s.repo === REPO) ?? null;

describe('扩展里那份拷贝的新鲜度', () => {
  test('CI 里必须真的查过 —— 跳过等于没测', () => {
    if (!process.env.CI) return; // 本地缺仓库是正常的
    assert.ok(EXT, 'CI 里必须并排检出 doubak-extension，否则下面那条会静默跳过');
  });

  const skip = EXT ? false : '找不到 doubak-extension —— 单独 clone 这一个仓库时这是正常的';

  test('`src/vendor/` 里的每个文件都还是这里的同一份', { skip }, () => {
    assert.ok(source, `扩展的 SOURCES 里没有 ${REPO} —— 名单被改坏了，或者这个仓库改名了`);

    const want = mod.renderOne(source, ROOT); // 抛出来的话说明上游少文件，信息在脚本里
    const dest = join(EXT, 'src', 'vendor', source.dest);
    const stale = [];
    for (const [name, text] of want) {
      const p = join(dest, name);
      if (!existsSync(p)) { stale.push(`${name}（扩展那边没有）`); continue; }
      if (readFileSync(p, 'utf-8') !== text) stale.push(`${name}（不一致）`);
    }

    // **必须真的比过东西。** 名单读空、路径写错的话，上面那个循环一次都不进，
    // 而一个空循环是绿的——这条检查会从此永远绿着，正是它要防的那种失效。
    assert.ok(want.size > 0, `一个文件都没比对到（${REPO} 在名单里有 ${source.files.length} 个）`);

    assert.deepEqual(stale, [],
      ['扩展里那份拷贝过期了。在扩展仓库里跑：',
        '    node tools/sync-vendor.mjs',
        '然后把 src/vendor/ 的改动一并提交 —— 两个仓库各一次提交。',
        '', ...stale.map((s) => `    ${s}`)].join('\n'));
  });
});
