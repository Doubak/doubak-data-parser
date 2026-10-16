import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBroadcasts } from '../src/extract-broadcast.js';
import { parse } from '../src/parse.js';

test('广播正文链接抽取与 text_parts 分段保留', async () => {
  const html = `
<div class="new-status status-wrapper" data-uid="82160871" data-sid="9871051745" data-aid="502623668" data-atype="topic">
  <div class="status-item" data-uid="82160871" data-sid="9871051745">
    <div class="mod">
      <div class="hd">
        <div class="text">
          <a href="https://www.douban.com/people/mewcatcher/" class="lnk-people">MewX</a>
          <span type="topic">说：</span>
        </div>
      </div>
      <div class="bd">
        <div class="content">
          <div class="title">
            <a href="https://www.douban.com/topic/502623668/?_spm_id=ODIxNjA4NzE">闲逛豆瓣有感</a>
          </div>
          <blockquote>
            <p style="white-space: pre-line;">突然想起那个领我入坑豆瓣的高中老同桌，点开账户却发现账号已经注销，这大抵就是备份豆瓣的意义吧～ <a href="https://www.douban.com/link2/?url=https%3A%2F%2Fdoubak.com%2Flog%2F2026-10-16-when-a-friend-deletes-account.html&amp;link2key=e5803012f3" target="_blank" rel="nofollow noopener noreferrer">当好友注销了账号：从「页面不存在」到 WARC 里复活的高中同桌 —— 开发日志</a>
@<a href="https://www.douban.com/people/69305634/" target="_blank">豆友69305634</a></p>
          </blockquote>
        </div>
        <div class="actions">
          <span class="created_at" title="2026-10-15 21:48:00">
            <a href="https://www.douban.com/topic/502623668/?_spm_id=ODIxNjA4NzE">昨天</a>
          </span>
        </div>
      </div>
    </div>
  </div>
</div>`;

  const { broadcasts } = extractBroadcasts(html, '82160871');
  assert.equal(broadcasts.length, 1);
  const b = broadcasts[0];

  assert.equal(b.sid, '9871051745');
  assert.equal(b.title, '闲逛豆瓣有感');
  assert.equal(b.text, '突然想起那个领我入坑豆瓣的高中老同桌，点开账户却发现账号已经注销，这大抵就是备份豆瓣的意义吧～ 当好友注销了账号：从「页面不存在」到 WARC 里复活的高中同桌 —— 开发日志\n@豆友69305634');

  // textParts 必须存在且有效
  assert.ok(Array.isArray(b.textParts));
  assert.equal(b.textParts.length, 4);

  // 硬性不变量：parts 拼起来逐字等于 text
  assert.equal(b.textParts.map((p) => p.text).join(''), b.text);

  // 第一段：普通文本
  assert.deepEqual(b.textParts[0], {
    text: '突然想起那个领我入坑豆瓣的高中老同桌，点开账户却发现账号已经注销，这大抵就是备份豆瓣的意义吧～ ',
  });

  // 第二段：解包 link2 的外链
  assert.deepEqual(b.textParts[1], {
    text: '当好友注销了账号：从「页面不存在」到 WARC 里复活的高中同桌 —— 开发日志',
    url: 'https://doubak.com/log/2026-10-16-when-a-friend-deletes-account.html',
  });

  // 第三段：换行与 @
  assert.deepEqual(b.textParts[2], {
    text: '\n@',
  });

  // 第四段：@豆友 链接
  assert.deepEqual(b.textParts[3], {
    text: '豆友69305634',
    url: 'https://www.douban.com/people/69305634/',
  });

  // 端到端 parse() 验证 canonical 生成
  const source = {
    bundleId: '20261015T222343Z-e4e7da', status: 'complete',
    manifest: { account: { user_id: '82160871', username: 'mewcatcher' } },
    crawlState: new Map(), coverage: new Map(),
    index: [{
      capture_id: '20261015T222343Z-e4e7da#000007',
      intent: 'broadcast.timeline', route_key: 'broadcast.timeline',
      url: 'https://www.douban.com/people/mewcatcher/statuses?p=1',
      verdict: 'ok', surface: 'html', observed_at: '2026-10-16T09:23:55+11:00',
    }],
    payload: () => html,
    close() {},
  };
  const result = await parse([source]);
  const record = result.broadcasts[0];
  const rev = record.revisions[0];
  assert.equal(rev.fields.text, b.text);
  assert.deepEqual(rev.fields.text_parts, b.textParts);
  assert.ok(rev.digests.text_parts);
});

test('无链接的正文保持 textParts 为 null', () => {
  const html = `
<div class="new-status status-wrapper" data-uid="82160871" data-sid="1234">
  <div class="status-item" data-uid="82160871" data-sid="1234">
    <div class="mod">
      <div class="hd"><div class="text"><a href="/people/mewcatcher/" class="lnk-people">MewX</a> 说：</div></div>
      <div class="bd"><blockquote><p>这是一条普通的纯文本广播，没有任何链接。</p></blockquote></div>
    </div>
  </div>
</div>`;
  const { broadcasts } = extractBroadcasts(html, '82160871');
  assert.equal(broadcasts[0].text, '这是一条普通的纯文本广播，没有任何链接。');
  assert.equal(broadcasts[0].textParts, null);
});

test('textParts 边界情况：两端多余空白与异常链接处理', () => {
  const html = `
<div class="new-status status-wrapper" data-uid="82160871" data-sid="5678">
  <div class="status-item" data-uid="82160871" data-sid="5678">
    <div class="mod">
      <div class="hd"><div class="text"><a href="/people/mewcatcher/" class="lnk-people">MewX</a> 说：</div></div>
      <div class="bd"><blockquote><p>
        前导空白 <a href="https://www.douban.com/link2/?target=no_url">无url参数的link2</a>
        中间文字 <a href="not-a-valid-url:$$$">非法URL链接</a>
        <a href="https://www.douban.com/misc/faq">普通豆瓣链接</a> 尾部空白
      </p></blockquote></div>
    </div>
  </div>
</div>`;
  const { broadcasts } = extractBroadcasts(html, '82160871');
  const b = broadcasts[0];
  assert.ok(b.textParts);
  assert.equal(b.textParts.map((p) => p.text).join(''), b.text);
  assert.equal(b.textParts[1].url, 'https://www.douban.com/link2/?target=no_url');
  assert.equal(b.textParts[3].url, 'not-a-valid-url:$$$');
  assert.equal(b.textParts[5].url, 'https://www.douban.com/misc/faq');
});

