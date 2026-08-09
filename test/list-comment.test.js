/**
 * 标记列表页上的短评。
 *
 * 这一组的由来：**音乐 84 条标记 0 条有短评，舞台剧 5 条标记 0 条有短评**——
 * 两个整齐的零，一句告警都没有，站点上那些作品页就是干干净净的空白。
 * 原因是三种媒介共用了 `<span class="comment">`，而那是影视独有的。
 *
 * CLAUDE.md 里「每种媒介一套，这不是可以统一的东西」讲的正是这个形状（当时的
 * 例子是游戏的评分与短评）。**这是第二次**，所以这里按媒介一条条钉住。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { extractMarks } from '../src/extract.js';

/**
 * 一个条目容器。三种媒介的条目结构一样，差别只在短评那一格里包不包 span。
 *
 * @param {{id: string, base: string, comment?: string|null, tail?: string}} o
 */
const item = ({ id, base, comment = null, tail = '' }) => `
<div class="item">
  <div class="pic"><a href="${base}${id}/"><img src="https://img1.doubanio.com/x.jpg"></a></div>
  <div class="info"><ul>
    <li class="title"><a href="${base}${id}/"><em>某作品</em></a></li>
    <li class="intro">元信息 / 2024</li>
    <li>
      <span class="rating4-t"></span>
      <span class="date">2024-01-02</span>
      <span class="tags">标签: 甲 乙</span>
    </li>
    ${comment === null ? '' : `<li>${comment}${tail}</li>`}
    <li class="clearfix opt-ln"><div class="opt-l gact"><a>修改</a></div></li>
  </ul></div>
</div>`;

const MOVIE = 'https://movie.douban.com/subject/';
const MUSIC = 'https://music.douban.com/subject/';
const DRAMA = 'https://www.douban.com/location/drama/';

describe('短评：三种媒介三种写法，同一个判据', () => {
  test('影视包在 `<span class="comment">` 里', () => {
    const { marks } = extractMarks(item({ id: '1', base: MOVIE, comment: '<span class="comment">这讲的是个啥</span>' }), 'movie');
    assert.equal(marks[0].comment, '这讲的是个啥');
  });

  test('**音乐是裸在 `<li>` 里的** —— 没有任何 class', () => {
    // 实测 https://music.douban.com/subject/26856870/ 那条「欢乐」。
    const html = item({ id: '26856870', base: MUSIC, comment: '\n      欢乐\n    ' });
    const { marks } = extractMarks(html, 'music');
    assert.equal(marks[0].comment, '欢乐');
  });

  test('**舞台剧也是裸的**', () => {
    // 实测 https://www.douban.com/location/drama/10944608/。
    const html = item({ id: '10944608', base: DRAMA, comment: '团建选了看舞台剧/音乐剧的项目 _(:з)∠)_' });
    const { marks } = extractMarks(html, 'drama');
    assert.equal(marks[0].comment, '团建选了看舞台剧/音乐剧的项目 _(:з)∠)_');
  });

  test('没写短评就是 null —— 不能把评分那一行当成短评', () => {
    // 没有短评时，操作栏前面那个 `<li>` 正是评分/日期/标签那一行。
    // 取错的话每条没写短评的标记都会得到一句「2024-01-02 标签: 甲 乙」。
    for (const [medium, base] of [['movie', MOVIE], ['music', MUSIC], ['drama', DRAMA]]) {
      const { marks } = extractMarks(item({ id: '2', base }), medium);
      assert.equal(marks[0].comment, null, `${medium} 不该凭空多出一句短评`);
      assert.deepEqual(marks[0].tags, ['甲', '乙'], `${medium} 的标签本身要照常抽到`);
    }
  });

  test('**`(N 有用)` 不许进短评** —— 它是上游的易变量', () => {
    // 点赞计数在同一个 `<li>` 里。实测同一条标记两次抓取之间从 `(5 有用)` 变成
    // `(1 有用)`，短评一个字没动——算进去就会凭空多出一条修订，看起来像用户改了
    // 短评。与「1740人浏览」进日记正文是同一个错，而 canonical 存在的全部理由
    // 就是「这条什么时候改的」。
    const html = item({
      id: '30284835', base: MOVIE,
      comment: '<span class="comment">画风还是原汁原味的京阿尼，期待后续！</span>',
      tail: '\n    <span class="pl">(5 有用)</span>',
    });
    const html2 = html.replace('(5 有用)', '(1 有用)');
    const a = extractMarks(html, 'movie').marks[0].comment;
    const b = extractMarks(html2, 'movie').marks[0].comment;
    assert.equal(a, '画风还是原汁原味的京阿尼，期待后续！');
    assert.equal(a, b, '点赞数变了，短评不该跟着变');
  });

  test('**只有标题的条目：短评是 null，不是片名**', () => {
    // 真实档案里有这种条目——没有评分、没有日期、没有标签、没有短评，
    // `<li class="title">` 后面直接就是操作栏。判据只看 `<li>` 里面有什么的话，
    // 那个 title 的 class 已经在切片之外，于是 8 部电影的「短评」变成了自己的片名：
    // 「V字仇杀队」「铁西区第一部分：工厂」。
    //
    // 这是最坏的一种错：**它产出的是像样的中文**，看一眼像用户真写过。
    const html = `
      <div class="item comment-item" data-cid="826634323">
        <div class="pic"><a href="${MOVIE}1309046/"><img src="https://img1.doubanio.com/x.png"></a></div>
        <div class="info"><ul>
          <li class="title"><a href="${MOVIE}1309046/"><em>V字仇杀队</em></a></li>
          <li class="clearfix opt-ln"><div class="opt-l gact"><a>删除</a></div></li>
        </ul></div>
      </div>`;
    const { marks } = extractMarks(html, 'movie');
    assert.equal(marks[0].title, 'V字仇杀队');
    assert.equal(marks[0].comment, null, '片名不是短评');
  });

  test('裸短评那种也要挡住 `(N 有用)`', () => {
    // 音乐/舞台剧今天没有这个计数，但判据不该依赖「今天恰好没有」——
    // 这个项目从一个手上的样本推出封闭集合已经栽过四次。
    const html = item({ id: '3', base: MUSIC, comment: '欢乐', tail: '<span class="pl">(2 有用)</span>' });
    assert.equal(extractMarks(html, 'music').marks[0].comment, '欢乐');
  });
});
