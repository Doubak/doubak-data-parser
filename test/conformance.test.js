/**
 * 跑 doubak-data-specs 的 canonical 一致性用例。
 *
 * 用例本身在规范仓库里（`canonical/tests/cases/`），**不在这里**。这是刻意的：
 * 它们是规范的一部分，任何语言写的解析器都该能跑；这个文件只是第一个实现。
 *
 * ## 每个用例都是一组**合法**的 bundle
 *
 * 不是坏数据。坏的是一个天真的解析器从它们身上得出的结论——而它翻车的时候
 * **不会报错**，会安安静静地产出错数据。那正是这套用例要拦的东西。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { openAll } from '../src/bundle-source.js';
import { parse } from '../src/parse.js';

/**
 * 规范仓库的位置。
 *
 * 七个独立仓库并排放在同一个目录下，所以是 `../../doubak-data-specs`。
 * 找不到就整组跳过——**不是失败**：别人 clone 单个仓库时那是正常情况。
 */
const CASES = new URL('../../doubak-data-specs/canonical/tests/cases', import.meta.url).pathname;

/** @param {object} out `parse()` 的产出 */
function summarize({ marks, broadcasts, longform }, warnings) {
  const authorities = new Set();
  const identityLayers = new Set();
  let revisions = 0;
  for (const m of marks) {
    identityLayers.add(m.identity_layer);
    revisions += m.revisions.length;
    for (const r of m.revisions) for (const o of r.observations) authorities.add(o.absence_authority);
  }
  return {
    marks: marks.length,
    mark_revisions: revisions,
    authorities: [...authorities].sort(),
    identity_layers: [...identityLayers].sort(),
    warning_types: [...new Set(warnings.map((w) => w.type))].sort(),

    broadcasts: broadcasts.length,
    broadcast_revisions: broadcasts.reduce((n, b) => n + b.revisions.length, 0),
    // **观测数不等于修订数。** 同一条广播在同一页上出现两次（头插翻页重叠）只是
    // 一次观测——抽取器不去重的话，这个数会变成 2，而记录数与修订数都还是 1。
    // 只断言后两者的话，去重那一步被删掉也测不出来。
    broadcast_observations: broadcasts.reduce(
      (n, b) => n + b.revisions.reduce((k, r) => k + r.observations.length, 0), 0,
    ),
    // 只收非 null 的——「收藏图书到豆列」映射不到三种标记状态，那时必须是 null。
    broadcast_statuses: [...new Set(
      broadcasts.flatMap((b) => b.revisions.map((r) => r.fields.status)).filter(Boolean),
    )].sort(),

    longform: longform.length,
    longform_revisions: longform.reduce((n, r) => n + r.revisions.length, 0),
    longform_body_contains: longform.map((r) => r.revisions[0].fields.body ?? '').join('\n'),
  };
}

describe('canonical 一致性用例', () => {
  if (!existsSync(CASES)) {
    test('规范仓库不在旁边，跳过', (t) => t.skip(`找不到 ${CASES}`));
    return;
  }

  const names = readdirSync(CASES).sort();

  test('用例是有的 —— 空目录不该悄悄算通过', () => {
    // 这条守的是套件本身：`cases/` 被清空或路径写错时，上面的循环会一条都不跑，
    // 而测试报告仍然全绿。那比用例失败更糟。
    assert.ok(names.length >= 15, `只找到 ${names.length} 个用例`);
  });

  for (const name of names) {
    const dir = join(CASES, name);
    const expect = JSON.parse(readFileSync(join(dir, 'expect.json'), 'utf-8'));
    // EXPECTED.txt 是人看的那一半：这个用例在守什么、为什么。断言失败时把它打出来，
    // 免得读的人还要去翻另一个仓库。
    const why = readFileSync(join(dir, 'EXPECTED.txt'), 'utf-8').trim();

    test(name, () => {
      const out = parse(openAll(join(dir, 'bundles')));
      const got = summarize(out, out.warnings);

      for (const [key, want] of Object.entries(expect)) {
        const actual = got[key];
        // `*_contains` 是子串断言（正文太长，不适合逐字比）；其余是相等或集合相等。
        const ok = key.endsWith('_contains')
          ? String(actual).includes(String(want))
          : Array.isArray(want)
            ? want.every((v) => actual.includes(v)) && actual.length === want.length
            : actual === want;
        assert.ok(
          ok,
          `${name}: ${key} 应为 ${JSON.stringify(want)}，实际 ${JSON.stringify(actual)}\n\n${why}\n`,
        );
      }
    });
  }
});
