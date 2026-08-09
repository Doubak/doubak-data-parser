/**
 * 实体解码。
 *
 * 这组测试的由来是生成的样张站点上肉眼可见的 `&#34;`：解析器漏解一次，站点生成器
 * 再按规矩把 `&` 转义成 `&amp;`，于是 `&#34;` 被忠实地印在了页面上。
 *
 * 所以这里有两层判据：**这个函数本身对**，以及**四个抽取器都真的用了它**。
 * 只测第一层的话，再加一个抽取器又会漏——那正是这次的形状。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { decodeEntities, stripTagsAndDecode } from '../src/html-entities.js';
import { extractMarks } from '../src/extract.js';
import { extractLongform } from '../src/extract-longform.js';
import { extractBroadcasts } from '../src/extract-broadcast.js';
import { extractInfo } from '../src/extract-subject.js';

describe('decodeEntities', () => {
  test('具名与数字实体都解', () => {
    assert.equal(decodeEntities('半支烟&#34;的解说'), '半支烟"的解说');
    assert.equal(decodeEntities('&#39;s The Mummy'), "'s The Mummy");
    assert.equal(decodeEntities('纸上&lt;传奇&gt;'), '纸上<传奇>');
    assert.equal(decodeEntities('A&amp;B'), 'A&B');
    assert.equal(decodeEntities('&quot;x&quot;'), '"x"');
    assert.equal(decodeEntities('&apos;'), "'");
    assert.equal(decodeEntities('&#x22;'), '"');
    assert.equal(decodeEntities('&#X4E2D;'), '中');
  });

  test('**`&amp;lt;` 解成 `&lt;`，不是 `<`**', () => {
    // 四份旧实现全都栽在这里：`&amp;` 排在最前面解，于是
    // `&amp;lt;` →（解 &amp;）→ `&lt;` →（解 &lt;）→ `<`。
    // 而 `&amp;lt;` 的原文是**字面的四个字符 `&lt;`**——讨论 HTML 转义的短评里
    // 就会写出这个，而链式解码把它变成了一个尖括号，之后再也还原不回去。
    assert.equal(decodeEntities('&amp;lt;'), '&lt;');
    assert.equal(decodeEntities('&amp;#34;'), '&#34;');
    assert.equal(decodeEntities('&amp;amp;'), '&amp;');
  });

  test('认不出来的原样留着 —— 不猜一个字符出来', () => {
    assert.equal(decodeEntities('&copyright;'), '&copyright;');
    assert.equal(decodeEntities('&;'), '&;');
    assert.equal(decodeEntities('a & b'), 'a & b');
    // 没有分号的不算引用：短评里「AT&T」就是这么写的
    assert.equal(decodeEntities('AT&T'), 'AT&T');
  });

  test('不是字符的码位原样留着 —— 不造 U+FFFD', () => {
    assert.equal(decodeEntities('&#xD800;'), '&#xD800;'); // 代理区
    assert.equal(decodeEntities('&#0;'), '&#0;');
    assert.equal(decodeEntities('&#1114112;'), '&#1114112;'); // > U+10FFFF
  });

  test('`&nbsp;` 解成 U+00A0，不是普通空格', () => {
    // 页面上写的就是不换行空格。改成 ' ' 是一次静默改写，而归一化是下游的事。
    assert.equal(decodeEntities('a&nbsp;b'), 'a b');
  });

  test('stripTagsAndDecode：先剥标签，再解实体', () => {
    // 反过来的话 `&lt;script&gt;` 会先变成 `<script>`，然后被当成标签删掉。
    assert.equal(stripTagsAndDecode('<p>写了 &lt;script&gt; 三个字</p>'), '写了 <script> 三个字');
    assert.equal(stripTagsAndDecode('<em>a</em>&amp;<b>b</b>'), 'a&b');
  });
});

describe('四个抽取器都真的解实体', () => {
  // 每条都构造成「不解就会原样带出 `&#34;` 之类」的样子。加第五个抽取器时，
  // 这个 describe 就是那份「别忘了」的清单。

  test('标记列表页：标题与短评', () => {
    const html = `
      <div class="item">
        <li class="title"><a href="https://movie.douban.com/subject/1/"><em>木乃伊 &#39;95</em></a></li>
        <span class="date">2024-01-02</span>
        <span class="comment">感谢up主&#34;半支烟&#34;的解说</span>
      </div>`;
    const { marks } = extractMarks(html, 'movie');
    assert.equal(marks.length, 1);
    assert.equal(marks[0].title, "木乃伊 '95");
    assert.equal(marks[0].comment, '感谢up主"半支烟"的解说');
  });

  test('作品详情页：#info 的值', () => {
    const html = '<div id="info"><span class="pl">又名:</span> 犯罪&amp;101 / Lee&#39;s Mummy<br></div>';
    assert.deepEqual(extractInfo(html)['又名'], ['犯罪&101', "Lee's Mummy"]);
  });

  test('广播：正文', () => {
    const html = `
      <div class="new-status status-wrapper" data-uid="7" data-sid="100">
        <blockquote><p>纸上&lt;传奇&gt;，&#34;很怀念&#34;</p></blockquote>
      </div>`;
    const { broadcasts } = extractBroadcasts(html, '7');
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].text, '纸上<传奇>，"很怀念"');
  });

  test('长文：标题与正文', () => {
    const html = `
      <div id="note-42"></div>
      <h1>说说 &lt;沉默之丘&gt;</h1>
      <span class="pub-date">2024-05-06 07:08:09 澳大利亚</span>
      <div id="link-report">正文里的 &amp; 与 &#39;引号&#39;</div>
      <div id="note_42_footer"></div>`;
    const note = extractLongform(html, 'note');
    assert.equal(note.title, '说说 <沉默之丘>');
    assert.equal(note.body, "正文里的 & 与 '引号'");
  });
});

describe('实体解码只有一份实现', () => {
  test('**抽取器里不许再各写各的 `&amp;` → `&`**', () => {
    // 原来四个文件四张表，各认五到八种，而 `extract.js` 一种都不认。发散的直接后果
    // 就是这次的 bug：漏掉的那个文件恰好是标题和短评的来源。
    //
    // 判据是「除了 html-entities.js，src/ 里不许出现把实体替换成字符的 replace」。
    const offenders = [];
    for (const f of readdirSync('src')) {
      if (!f.endsWith('.js') || f === 'html-entities.js') continue;
      const text = readFileSync(join('src', f), 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/^\s*(\*|\/\/)/.test(line)) return; // 注释里写得出 &amp; 是正常的
        if (/replace\(\s*\/&(amp|lt|gt|quot|apos|nbsp|#\d)/.test(line)) {
          offenders.push(`src/${f}:${i + 1}`);
        }
      });
    }
    assert.deepEqual(
      offenders, [],
      '实体解码只能来自 src/html-entities.js —— 各写各的必然发散，而发散的样子是'
      + '「某一类字段的实体没解开」，它不报错，只会被下游忠实地印在页面上',
    );
  });
});
