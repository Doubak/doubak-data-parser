import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parse.js';
import { absenceAuthority } from '../src/authority.js';

const state = { route_key: 'interest.movie.collect', contiguous: true, gaps: [], enumeration: 'full', advanced: true };

function source(bundleId, scope, { tags = true, comment = '原短评' } = {}) {
  const html = `<div class="item" data-cid="123"><div class="info"><ul>
    <li class="title"><a href="https://movie.douban.com/subject/1234567/"><em>电影</em></a></li>
    <li><span class="date">2026-01-01</span><span class="rating4-t"></span>
    ${tags ? '<span class="tags">标签: 剧情 日本</span>' : ''}</li>
    <li><span class="comment">${comment}</span></li><li class="clearfix opt-ln"></li></ul></div></div>`;
  return {
    bundleId, status: 'complete',
    manifest: { bundle_id: bundleId, account: { user_id: '111', username: 'target' }, crawl_scope: scope },
    index: [{ capture_id: `${bundleId}#000001`, url: 'https://movie.douban.com/people/target/collect',
      route_key: state.route_key, intent: 'interest.list.movie.collect', surface: 'html', verdict: 'ok',
      observed_at: bundleId.startsWith('202601') ? '2026-01-01T00:00:00Z' : '2026-02-01T00:00:00Z' }],
    crawlState: new Map([[state.route_key, state]]), coverage: new Map(), payload: () => html, close() {},
  };
}

test('公开范围不因 full/有下界/登录操作者获得删除推断权', () => {
  for (const operator_mode of ['authenticated', 'anonymous']) {
    for (const cs of [state, { ...state, enumeration: 'bounded', floor_time: '2026-01-01T00:00:00Z' }]) {
      assert.equal(absenceAuthority(cs, 'complete', undefined, { visibility: 'public', operator_mode }), 'none');
    }
  }
  assert.equal(absenceAuthority(state, 'complete'), 'whole_route');
});

test('本人完整观测后匿名缺少 tags，不清空已有标签或制造编辑', async () => {
  const own = source('20260101T000000Z-aaaaaa', { visibility: 'self', operator_mode: 'authenticated' });
  const anon = source('20260201T000000Z-bbbbbb', { visibility: 'public', operator_mode: 'anonymous' }, { tags: false });
  for (const sources of [[own, anon], [anon, own]]) {
    const out = await parse(sources);
    assert.equal(out.marks.length, 1);
    const revisions = out.marks[0].revisions;
    assert.equal(revisions.length, 1);
    assert.deepEqual(revisions[0].fields.tags, ['剧情', '日本']);
    const observation = revisions[0].observations.at(-1);
    assert.equal(observation.absence_authority, 'none');
    assert.deepEqual(observation.omitted_fields, ['tags']);
  }
});

test('匿名公开观测的真实短评修改仍产生修订，未展示标签保留已知值', async () => {
  const own = source('20260101T000000Z-aaaaaa', { visibility: 'self', operator_mode: 'authenticated' });
  const anon = source('20260201T000000Z-bbbbbb', { visibility: 'public', operator_mode: 'anonymous' }, { tags: false, comment: '公开修改' });
  const out = await parse([own, anon]);
  const revisions = out.marks[0].revisions;
  assert.equal(revisions.length, 2);
  assert.equal(revisions[1].fields.comment, '公开修改');
  assert.deepEqual(revisions[1].fields.tags, ['剧情', '日本']);
  assert.equal(revisions[1].observations[0].absence_authority, 'none');
});

test('只有匿名公开观测时，未展示 tags 省略字段，不能声明已清空', async () => {
  const out = await parse([source('20260201T000000Z-bbbbbb', { visibility: 'public', operator_mode: 'anonymous' }, { tags: false })]);
  const revision = out.marks[0].revisions[0];
  assert.equal(Object.hasOwn(revision.fields, 'tags'), false);
  assert.equal(Object.hasOwn(revision.digests, 'tags'), false);
  assert.equal(revision.observations[0].absence_authority, 'none');
});
