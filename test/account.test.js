/** 七类用户记录都必须携带同一份账号资料；作品目录不带账号。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '../src/parse.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8');

function source(bundleId, account, captures) {
  const index = captures.map(([intent, url], i) => ({
    capture_id: `${bundleId}#${String(i + 1).padStart(6, '0')}`,
    intent, route_key: intent === 'interest.list.movie.collect' ? 'interest.movie.collect' : intent,
    url, surface: 'html', verdict: 'ok', observed_at: '2026-07-01T00:00:00Z',
  }));
  const payloads = new Map(index.map((row, i) => [row.capture_id, captures[i][2]]));
  return {
    bundleId, manifest: { account }, status: 'complete', index,
    crawlState: new Map(), coverage: new Map(), payload: (row) => payloads.get(row.capture_id), close() {},
  };
}

test('昵称变更只出现在 manifest 中，也能补齐七类旧记录且不添加内容修订', async () => {
  const old = source('20260701T000000Z-aaaaaa', { user_id: '82160871', username: 'old' }, [
    ['interest.list.movie.collect', 'https://movie.douban.com/people/old/collect', `
      <h1>看过的电影(1)</h1><div class="item" data-cid="123"><div class="info"><ul>
      <li class="title"><a href="https://movie.douban.com/subject/1234567/"><em>电影</em></a></li>
      <li><span class="date">2026-01-01</span></li><li class="clearfix opt-ln"></li></ul></div></div>`],
    ['broadcast.timeline', 'https://www.douban.com/people/old/statuses', `
      <div class="new-status status-wrapper" data-sid="900" data-uid="82160871">
      <div class="text"><a class="lnk-people">作者</a>说</div>
      <span class="created_at" title="2026-01-01 12:00:00">日期</span></div>`],
    ['note.item', 'https://www.douban.com/note/123/', `
      <div id="note-123" class="note-container" data-url="https://www.douban.com/note/123/">
      <h1>日记</h1><div id="note_123_full"><div id="link-report"><div class="note"><p>正文</p></div></div></div>
      <div id="note_123_footer"><div class="note-footer-stat"></div></div></div>`],
    ['doulist.item', 'https://www.douban.com/doulist/45473911/', fixture('doulist-detail-comments.html')],
    ['photo.album', 'https://www.douban.com/photos/album/100276481/', fixture('photos-album.html')],
    ['group.item', 'https://www.douban.com/group/topic/258053730/', fixture('group-topic.html')],
    ['group.joins', 'https://www.douban.com/group/people/old/joins', fixture('group-joins.html')],
  ]);
  const account = { user_id: '82160871', username: 'new', nickname: '新昵称' };
  const newer = source('20260801T000000Z-bbbbbb', account, []);
  for (const input of [[old, newer], [newer, old]]) {
    const out = await parse(input);
    for (const kind of ['marks', 'broadcasts', 'longform', 'doulists', 'albums', 'groupTopics', 'groupJoins']) {
      assert.ok(out[kind].length > 0, `${kind} 必须真的解析到记录`);
      for (const record of out[kind]) {
        assert.deepEqual(record.account, account, kind);
        assert.equal(record.revisions.length, 1, kind);
        assert.equal('nickname' in record.revisions[0].fields, false);
      }
    }
    assert.ok(out.subjects.length > 0);
    assert.ok(out.subjects.every((record) => !('account' in record)));
  }
});
