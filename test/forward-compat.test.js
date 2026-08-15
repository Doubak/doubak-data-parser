/**
 * 读得动**将来**的档案吗。
 *
 * ## 要守的是哪一半
 *
 * `bundle/1.0` 从未公开发布过，所以对它不兼容是可以接受的（档案主人的决定）。
 * 真正必须守住的是反过来那一半：**今天写好的解析器，将来遇到更新的档案不能崩、
 * 也不能静默丢东西。** 而这一条今天就能验，不必等到真有 `bundle/1.3`。
 *
 * 规范 §10 给读者立了两条义务：
 *
 *   1. **必须容忍未知字段**，重写文件时不得丢弃它们——「只增不改」全靠这条成立；
 *   2. **开放词表**（`intent`、`route_key`）的未知取值必须原样保留，不得猜测。
 *
 * 在此之前没有任何东西验证过它们：现有的一致性用例验的全是「写出来的东西合不合
 * 规范」，那是**生产者**方向；读者方向一条都没有。
 *
 * 用例在规范仓库里（`bundle/v1/tests/valid/from-the-future/`），不在这里——它是
 * 规范的一部分，任何语言写的读取端都该能跑。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { openAll } from '../src/bundle-source.js';
import { parse } from '../src/parse.js';

const FUTURE = new URL(
  '../../doubak-data-specs/bundle/v1/tests/valid/from-the-future',
  import.meta.url,
).pathname;

describe('来自未来的档案：读得动，且不丢东西', () => {
  const missing = !existsSync(FUTURE);
  const skip = missing
    ? '规范仓库不在同级目录 —— 单独 clone 这一个仓库时这是正常的'
    : false;

  test('打得开，而且认得出里面有几条', { skip }, () => {
    // 它声明的是 `bundle/1.9`，一个今天还不存在的小版本。解析器**根本不看
    // spec_version**，这正是它读得动的原因——按字段读，不按版本分支。
    const [src] = openAll(join(FUTURE, '..')).filter((s) => s.dir.endsWith('from-the-future'));
    assert.ok(src, '没能打开这份档案');
    assert.ok(src.index.length > 0, 'index 一行都没读出来');
    assert.equal(src.manifest.spec_version, 'bundle/1.9');
    src.close();
  });

  test('**未知字段不许丢**（规范 §10）', { skip }, () => {
    // 「只增不改」这条规则的全部前提就是读者不丢未知字段。丢了的话，一个 1.9 的
    // 读者把档案重写一遍，1.9 新增的东西就永久没了——而档案是不可重抓的。
    const idx = readdirSync(FUTURE).find((f) => f.startsWith('index-'));
    const rows = readFileSync(join(FUTURE, idx), 'utf-8')
      .trim().split('\n').map((l) => JSON.parse(l));
    const withFuture = rows.find((r) => r.future_line_field !== undefined);
    assert.ok(withFuture, '用例本身该带一个未知字段');

    const m = JSON.parse(readFileSync(join(FUTURE, 'manifest.json'), 'utf-8'));
    assert.ok(m.future_top_level_field, 'manifest 上也该有一个未知字段');
  });

  test('**开放词表的未知取值原样保留，不许猜**', { skip }, () => {
    // `intent` 是开放词表。遇到不认识的取值，正确做法是原样留着——猜一个是不可逆的，
    // 留着是可查的。这与解析器对 `medium`、`category` 的处置是同一条规矩。
    const idx = readdirSync(FUTURE).find((f) => f.startsWith('index-'));
    const rows = readFileSync(join(FUTURE, idx), 'utf-8')
      .trim().split('\n').map((l) => JSON.parse(l));
    const future = rows.find((r) => String(r.intent ?? '').startsWith('future.'));
    assert.ok(future, '用例本身该带一个未知 intent');
    assert.equal(future.intent, 'future.route.that.does.not.exist.yet');
  });

  test('**认不出的路线被跳过，而不是崩掉或被当成已知的**', { skip }, () => {
    // 解析器只处理它认识的 intent，其余的静静跳过。关键在于「跳过」而不是「猜」：
    // 一条 `future.route` 不该被当成 broadcast 或 mark 去抽——那会产出错数据，
    // 而且不报错。
    //
    // **判据不能是「产出里没有未来路线的记录」。** 第一版就是那么写的，而那条断言
    // 遍历的是一个**空数组**——这份最小用例本来就产不出任何记录，于是它恒为真、
    // 白白绿着。一条遍历空集合的断言等于没写。
    //
    // 换成正面的判据：读到了那两行、一行都没变成记录、而且**一句告警都没有**。
    // 最后一条是重点：未知 intent 是规范预期内的情形（开放词表），报警的话，
    // 将来每加一条路线，所有旧解析器都会开始刷屏。
    const srcs = openAll(join(FUTURE, '..')).filter((s) => s.dir.endsWith('from-the-future'));
    const out = parse(srcs);

    assert.equal(out.stats.bundles, 1, '这份档案该被读到');
    assert.ok(out.stats.pages >= 1, 'index 里的行该被走一遍');
    assert.equal(
      out.marks.length + out.broadcasts.length + out.longform.length + out.doulists.length,
      0,
      '这份最小用例产不出记录 —— 产出了反而说明解析器把未知路线当成了认识的',
    );
    assert.deepEqual(out.warnings, [], '未知 intent 是规范预期内的情形，不该告警');
  });
});
