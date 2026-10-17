import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractProfile, avatarUrl } from '../src/extract-profile.js';
import { parse } from '../src/parse.js';
export const page = (src = 'https://img3.doubanio.com/icon/up123-1.jpg') => `<html><head><link rel="alternate" href="https://www.douban.com/feed/people/123/interests"></head><body>
<img src="https://img3.doubanio.com/icon/up999-1.jpg">
<div id="db-usr-profile"><div class="pic"><a href="https://www.douban.com/people/owner/">${src ? `<img src="${src}" alt="Owner">` : ''}</a></div>
<div class="info"><h1>Owner &amp; Friend<div class="signature_display"><img src="https://img3.doubanio.com/icon/up999-1.jpg"></div></h1></div></div></body></html>`;
const url = 'https://www.douban.com/people/123/';
function source(n, html, verdict = 'ok') {
 const bundleId = `202610${String(n).padStart(2,'0')}T000000Z-aaaaaa`;
 return { bundleId, status:'complete', manifest:{bundle_id:bundleId,account:{user_id:'123',username:'owner'},crawl_scope:{visibility:'public'}},
 index:[{capture_id:bundleId+'#000001',intent:'profile.overview',route_key:'profile.overview',surface:'html',verdict,url,observed_at:`2026-10-${String(n).padStart(2,'0')}T00:00:00Z`}],
 crawlState:new Map(),coverage:new Map(),payload:()=>html,close(){} };
}
test('profile avatar belongs to target, never operator, visitor or signature',()=>{
 assert.deepEqual(extractProfile(page(),url,'123').fields,{username:'owner',nickname:'Owner & Friend',avatar_url:'https://img3.doubanio.com/icon/up123-1.jpg'});
 assert.equal(extractProfile(page(),url,'999'),null);
 assert.equal(extractProfile(page('https://img3.doubanio.com/icon/up456-1.jpg'),url,'123'),null);
 assert.equal(extractProfile(page(),'https://www.douban.com/people/456/','123'),null);
 assert.equal(extractProfile(page(),'https://evil.example/people/123/','123'),null);
 const fake='<script>let x="<!--"; '+page()+'</script>';
 assert.equal(extractProfile(fake,url,'123'),null);
 assert.ok(extractProfile(fake+page(),url,'123'));
});
test('only supported HTTPS image hosts; default and absent avatars differ',()=>{
 for(const v of ['http://img3.doubanio.com/a','https://evil-doubanio.com/a','https://img3.doubanio.com@evil.example/a','data:image/png;base64,a','https://img3.doubanio.com:444/a']) assert.equal(avatarUrl(v),null);
 assert.equal(avatarUrl('//img3.doubanio.com/icon/up123-1.jpg'),'https://img3.doubanio.com/icon/up123-1.jpg');
 assert.equal(extractProfile(page('https://img3.doubanio.com/icon/user_normal.jpg'),url,'123').fields.avatar_url,null);
 assert.equal(Object.hasOwn(extractProfile(page(null),url,'123').fields,'avatar_url'),false);
});
test('observations preserve unchanged URLs, omissions and explicit defaults; order-independent',async()=>{
 const a=source(1,page()),b=source(2,page()),c=source(3,page(null)),d=source(4,page('https://img3.doubanio.com/icon/user_normal.jpg')),e=source(5,page(null)),bad=source(6,page(),'challenge');
 const out=await parse([e,b,bad,c,d,a]);
 assert.deepEqual(out.profile,(await parse([a,b,c,d,e,bad])).profile);
 const rev=out.profile[0].revisions;
 assert.equal(rev.length,2); assert.equal(rev[0].observations.length,3);
 assert.deepEqual(rev[0].observations[2].omitted_fields,['username','avatar_url']);
 assert.equal(rev[1].fields.avatar_url,null); assert.equal(rev[1].observations.length,2);
 assert.ok(rev.every(r=>r.observations.every(o=>o.absence_authority==='none')));
});
test('old empty sources and foreign pages cannot invent a profile',async()=>{
 assert.deepEqual((await parse([])).profile,[]);
 assert.deepEqual((await parse([source(1,page().replaceAll('123','456'))])).profile,[]);
 const s=source(1,page()); s.manifest=null; assert.deepEqual((await parse([s])).profile,[]);
});

test('profile chronology compares instants across offsets; tied instants use capture IDs', async()=>{
 const a=source(1,page()),b=source(2,page('https://img3.doubanio.com/icon/up123-2.jpg'));
 a.index[0].observed_at='2026-10-02T01:00:00+11:00'; // actually earlier than b
 b.index[0].observed_at='2026-10-01T15:00:00Z';
 const result=await parse([b,a]);
 assert.equal(result.profile[0].revisions.at(-1).fields.avatar_url,'https://img3.doubanio.com/icon/up123-2.jpg');
 b.index[0].observed_at='2026-10-01T14:00:00Z';
 assert.deepEqual((await parse([a,b])).profile,(await parse([b,a])).profile);
});
