import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extractSeries } from '../src/extract-series.js';
import { parse } from '../src/parse.js';
const fixture = name => readFileSync(new URL(`./fixtures/subject-series/${name}.html`, import.meta.url), 'utf8');
const url = id => `https://movie.douban.com/subject/${id}/`;
const film = fixture('film-before');
const extract = html => extractSeries(html, url('36848001'));

test('nine real archived configurations: additions, removals, order, null labels and explicit empty', () => {
  const sources=JSON.parse(readFileSync(new URL('./fixtures/subject-series/sources.json',import.meta.url),'utf8'));
  for(const source of sources) {
    const bytes=readFileSync(new URL(`./fixtures/subject-series/${source.file}`,import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),source.excerpt_sha256,source.file);
    const value=extractSeries(bytes.toString('utf8'),source.source_url).value;
    assert.deepEqual(value.items.map(i=>i.id),source.expected.other_ids,source.file);
    assert.equal(value.claimed_total,source.expected.claimed_total,source.file);
  }

  const read = (name, id) => { const r = extractSeries(fixture(name), url(id)); assert.deepEqual(r.diagnostics, []); return r.value; };
  assert.equal(read('film-before','36848001').items.length, 3);
  assert.equal(read('film-after','36848001').items.length, 4);
  assert.equal(read('tv-many-members','36653963').items.length, 10);
  assert.equal(read('members-before-removal','26642033').items.length, 19);
  assert.equal(read('members-after-removal','26642033').items.length, 14);
  assert.deepEqual(read('order-before','1297359').items.map(i=>i.id), read('order-after','1297359').items.map(i=>i.id).reverse());
  assert.equal(read('no-series','37007685').series_url, null);
  assert.equal(read('no-series','37007685').scope, 'complete');
  assert.equal(read('singleton-series','34802334').claimed_total, 1);
  assert.equal(read('singleton-series','34802334').items.length, 0);
  assert.equal(read('film-before','36848001').items[0].season_label, null);
  assert.equal(read('film-before','36848001').scope, 'complete');
  assert.equal(read('film-after','36848001').scope, 'complete');
  assert.equal(read('members-before-removal','26642033').scope, 'complete');
  assert.equal(read('tv-many-members','36653963').scope, 'complete');
  assert.equal(extractSeries(fixture('film-before').replace("series_total: '4'", "series_total: '9'"), url('36848001')).value.scope, 'partial');
});

test('script boundaries, comments and inert/quoted fake configs cannot supply evidence', () => {
  for (const html of [`<!--${film}-->`, `<textarea>${film}</textarea>`, `<template>${film}</template>`,
    film.replace('<script>','<script type="application/ld+json">'),
    `<script>const text = ${JSON.stringify(film.replaceAll('</script>', '<end>'))};</script>`,
    `<script>/* ${film.replaceAll('</script>', '<end>')} */</script>`]) {
    assert.equal(extract(html).value, undefined);
  }
  assert.deepEqual(extract(`<div id="series-items"></div>${film}<div>同系列作品 <a href="${url('999')}">推荐</a></div>`).value, extract(film).value);
  assert.equal(extract(film.replace('var _CONFIG', 'function f() { var _CONFIG').replace('</script>','}</script>')).value, undefined);
});

test('unsupported, conflicting, truncated and executable values never clear a series', () => {
  for (const html of [film.replace("SUBJECT_ID: '36848001'", "SUBJECT_ID: '999'"),
    film.replace("SUBJECT_ID: '36848001'", "SUBJECT_ID: '36848001', SUBJECT_ID: '36848001'"),
    film.replace("series_total: '4'", "series_total: fn()"),
    film.replace("series_total: '4'", "series_total: '9007199254740993'"),
    film.replace('SERIES_OTHER_SUBJECTS:', 'OTHER:'),
    film.replace("series_total: '4'", "series_total: '4' + evil()"),
    film.replace('BJ单身日记', '</script>'), film.slice(0,-50),
    film + fixture('film-after'), film.replace('SERIES: {','SERIES: { get x() { return 1 },'),
    film.replace('var _CONFIG', 'if (false) var _CONFIG'),
    '<script>const text = `outer ${`' + film.replaceAll('<script>','').replaceAll('</script>','') + '`}`;</script>']) {
    assert.equal(extract(html).value, undefined);
  }
  assert.ok(extract(film.replace("series_total: '4'", "series_total: '9'")).diagnostics.length);
  assert.deepEqual(extract(film+film).value, extract(film).value);
});

test('member URL identity is exact; malformed members downgrade but do not erase valid evidence', () => {
  for (const bad of ['https://evil.movie.douban.com/subject/1304585/', 'https://movie.douban.com.evil/subject/1304585/',
    'https://user@movie.douban.com/subject/1304585/', 'javascript:alert(1)',
    'https://movie.douban.com/subject/1304585/reviews/', url('999')]) {
    const html=film.replace('https:\\/\\/movie.douban.com\\/subject\\/1304585\\/', bad);
    const r=extract(html); assert.equal(r.value.items.length,2,bad); assert.equal(r.value.scope,'partial');
  }
  assert.equal(extractSeries(film,'https://book.douban.com/subject/36848001/').value,undefined);
  assert.equal(extractSeries(film,'https://movie.douban.com/subject/36848001/reviews/').value,undefined);
  assert.equal(extract(film.replace('BJ单身日记','[A] &amp; \\"B\\"')).value.items[0].title,'[A] &amp; "B"');
});

export function seriesSource(entries) {
  const bundleId = '20261113T000000Z-abcdef';
  return { bundleId, status:'complete', manifest: { bundle_id:bundleId, account:{user_id:'111', username:'tester'} },
    crawlState:new Map(), coverage:new Map(), close(){},
    index:entries.map((e,i)=>({capture_id:`${bundleId}#${String(i+1).padStart(6,'0')}`, observed_at:e.at,
      route_key:e.list?'interest.movie.collect':'interest.item', intent:e.list?'interest.list.movie.collect':'interest.item',
      url:e.list?'https://movie.douban.com/people/tester/collect':url(e.id??'36848001'), surface:'html', verdict:e.verdict??'ok'})),
    payload(row){return entries[Number(row.capture_id.split('#')[1])-1].html;} };
}
export function markHtml(id='36848001', title='BJ', meta='old') { return `<div class="item" data-cid="${id}"><div class="info"><ul><li class="title"><a href="${url(id)}"><em>${title}</em></a></li><li class="intro">${meta}</li><li><span class="date">2026-01-01</span><span class="rating4-t"></span></li><li><span class="comment">保留短评</span></li></ul></div></div>`; }
const at = n => `2026-01-0${n}T00:00:00Z`;
test('sparse chronological replay: detail-only changes, omitted metadata and no future backfill', async () => {
  const s=seriesSource([{at:at(1),list:true,html:markHtml()}, {at:at(2),html:film},
    {at:at(3),list:true,html:markHtml('36848001','new')}, {at:at(4),html:'<div>old template</div>'},
    {at:at(5),html:fixture('film-after')}]);
  const a=await parse([s]);
  assert.equal(a.marks.length,1); assert.equal(a.marks[0].revisions.length,1);
  const revs=a.subjects[0].revisions;
  assert.equal(revs.length,4);
  assert.equal(revs[0].fields.series,undefined); assert.equal(revs[0].fields.aliases,null);
  assert.equal(revs[1].fields.series.items.length,3); assert.equal(revs[1].first_observed_at,at(2));
  assert.equal(revs[2].fields.title,'new'); assert.equal(revs[2].observations.length,2);
  assert.ok(revs[2].observations.every(o=>o.omitted_fields.includes('series')));
  assert.equal(revs[3].fields.series.items.length,4); assert.equal(revs[3].first_observed_at,at(5));
  assert.ok(revs.every(r=>r.observations.every(o=>!o.omitted_fields.includes('rating')&&!o.omitted_fields.includes('tags'))));
  s.index.reverse(); const b=await parse([s]); assert.deepEqual(a.subjects,b.subjects); assert.deepEqual(a.marks,b.marks);
  assert.deepEqual((await parse([s,s])).subjects,a.subjects);
});

test('detail before list is retained only with mark eligibility; failures cannot clear; explicit empty can', async () => {
  const d={at:at(1),html:film}; assert.equal((await parse([seriesSource([d])])).subjects.length,0);
  const empty=fixture('no-series').replace('37007685','36848001');
  const out=await parse([seriesSource([d,{at:at(2),list:true,html:markHtml()},
    {at:at(3),html:empty,verdict:'denied'},{at:at(4),html:empty}])]);
  const r=out.subjects[0].revisions;
  assert.equal(r[0].fields.title,undefined); assert.equal(r[0].fields.series.items.length,3);
  assert.equal(r.at(-1).fields.series.items.length,0); assert.equal(r.at(-1).first_observed_at,at(4));
  assert.equal(out.marks[0].revisions.length,1);
});

test('same-time conflicting series are deterministic and diagnosed', async () => {
  const s=seriesSource([{at:at(1),list:true,html:markHtml()},{at:at(2),html:film},{at:at(2),html:fixture('film-after')}]);
  const a=await parse([s]); assert.ok(a.warnings.some(w=>w.type==='series_time_conflict'));
  s.index.reverse(); assert.deepEqual((await parse([s])).subjects,a.subjects);
});

test('JSON members reject single quotes/trailing commas; field key order does not change digest', async()=>{
  for(const html of [film.replace('"title":"BJ单身日记"',"'title':'BJ单身日记'"), film.replace('"year":"2001","id":"1304585"}','"year":"2001","id":"1304585",}')]) assert.equal(extract(html).value,undefined);
  const s=seriesSource([{at:at(1),list:true,html:markHtml()},{at:at(2),html:film},
    {at:at(3),html:film.replace('"rating":"7.5","title":"BJ单身日记"','"title":"BJ单身日记","rating":"7.5"')}]);
  const out=await parse([s]);assert.equal(out.subjects[0].revisions.length,2);
  assert.equal(out.subjects[0].revisions.at(-1).observations.length,2);
});

import { spawnSync } from 'node:child_process';
test('sparse replay does not retain full HTML backing strings under a bounded heap',()=>{
  const program=`import {parse} from ${JSON.stringify(new URL('../src/parse.js',import.meta.url).href)};
  const bundleId='20261113T000000Z-aabbcc';
  const index=Array.from({length:70},(_,i)=>({capture_id:bundleId+'#'+String(i+1).padStart(6,'0'),
    observed_at:new Date(Date.UTC(2026,0,1,0,i)).toISOString(),route_key:'interest.movie.collect',
    intent:'interest.list.movie.collect',verdict:'ok',surface:'html',url:'https://movie.douban.com/people/tester/collect'}));
  const source={bundleId,status:'complete',manifest:{account:{user_id:'111'}},index,crawlState:new Map(),coverage:new Map(),close(){},
    payload:row=>'<!--'+row.capture_id+'x'.repeat(3*1024*1024)+'-->'+${JSON.stringify(markHtml())}};
  const out=await parse([source]);if(out.subjects.length!==1||out.subjects[0].revisions.length!==1) process.exit(2);`;
  const r=spawnSync(process.execPath,['--max-old-space-size=128','--input-type=module','-e',program],{encoding:'utf8',timeout:30000});
  assert.equal(r.status,0,r.stderr);
});

test('partial mark coverage {A, B, C}: A and B marked, unmarked C stays in series items without creating mark/subject', async () => {
  const bHtml = fixture('film-before')
    .replaceAll('1304585', '36848001')
    .replace("SUBJECT_ID: '36848001'", "SUBJECT_ID: '1304585'");
  const cHtml = fixture('film-before')
    .replace("SUBJECT_ID: '36848001'", "SUBJECT_ID: '1308819'");
  const s = seriesSource([
    { at: at(1), list: true, html: markHtml('36848001', 'A') + markHtml('1304585', 'B') },
    { at: at(2), id: '36848001', html: film },
    { at: at(3), id: '1304585', html: bHtml },
    { at: at(4), id: '1308819', html: cHtml },
  ]);
  const out = await parse([s]);
  assert.deepEqual(out.marks.map(m => m.subject.id).sort(), ['1304585', '36848001']);
  assert.deepEqual(out.subjects.map(x => x.id).sort(), ['1304585', '36848001']);
  const byId = new Map(out.subjects.map(x => [x.id, x.revisions.at(-1).fields.series.items.map(i => i.id)]));
  assert.ok(byId.get('36848001').includes('1308819'));
  assert.ok(byId.get('1304585').includes('1308819'));
});

test('unparseable observed_at still uses deterministic bundle/capture tie-breakers without false time conflicts', async () => {
  const s = seriesSource([
    { at: 'not-a-date-a', list: true, html: markHtml() },
    { at: 'not-a-date-a', html: film },
    { at: 'not-a-date-b', html: fixture('film-after') },
  ]);
  const a = await parse([s]);
  assert.equal(a.warnings.some(w => w.type === 'series_time_conflict'), false);
  s.index.reverse();
  const b = await parse([s]);
  assert.deepEqual(b.subjects, a.subjects);
});
