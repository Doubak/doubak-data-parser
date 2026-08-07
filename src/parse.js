/**
 * 主流程：一堆 bundle → canonical。
 *
 * ## 它是对**全集**的纯函数
 *
 * 不是「在上次结果上打补丁」。canonical/INGESTION.md §5.1 要求：对 N 份档案跑一遍，
 * 再对 N+1 份跑一遍，第二次不得丢掉第一次得到的任何东西。做成增量的话，这条性质
 * 要靠小心维护；做成纯函数则它是**免费**的。
 *
 * 增量解析可以后来再加，那是缓存优化，不是语义。
 */

import { extractMarks } from './extract.js';
import { extractBroadcasts } from './extract-broadcast.js';
import { extractLongform } from './extract-longform.js';
import { digestAll, sameRevision } from './digest.js';
import { absenceAuthority, isContent, hasUnknownVerdict, isRecalibratable } from './authority.js';

export const PARSER_VERSION = 'doubak-data-parser/0.0.1';
export const CANONICAL_VERSION = 'canonical/1.0';

/** 路线状态词 → canonical 的封闭词表。 */
const STATUS = { collect: 'done', do: 'doing', wish: 'wish' };

/**
 * @param {import('./bundle-source.js').BundleSource[]} sources
 * @param {{parserVersion?: string, timezone?: string}} [opts]
 */
export function parse(sources, opts = {}) {
  const parserVersion = opts.parserVersion ?? PARSER_VERSION;
  const tz = opts.timezone ?? 'Asia/Shanghai';

  /** @type {Map<string, object>} 身份键 → 记录 */
  const marks = new Map();
  /** @type {Map<string, object>} `${medium}:${id}` → 作品 */
  const subjects = new Map();
  /** @type {Map<string, object>} data-sid → 广播 */
  const broadcasts = new Map();
  /** @type {Map<string, object>} `${kind}:${id}` → 日记 / 评论 */
  const longform = new Map();
  const warnings = [];
  const stats = {
    bundles: 0,
    pages: 0,
    observations: 0,
    skipped: {},
    /**
     * **改一行选择器就能救回来的捕获。**
     *
     * 这是 `verdict_reason`（bundle/1.2）真正兑现的地方。解析器能一次扫完所有档案，
     * 回答一个别处回答不了的问题：**欠了多少，以及要不要求人重抓。**
     *
     * `frame_anchors_missing` / `not_an_image` 这两类的页面已经原样躺在 WARC 里，
     * 改好抽取器离线重跑就行；而 `empty_body` / `server_error` 那类得真的重抓。
     * 混成一句「有 N 条失败」的话，用户只能去做代价最大的那个动作。
     *
     * 按 route_key 分组：一次改动通常只修好一条路线，分组之后「改这个能救回多少」
     * 是直接可读的。
     * @type {Record<string, number>}
     */
    recalibratable: {},
  };

  // 观测必须按时间升序处理，否则「第一次看到」和「最后一次看到」会记反。
  // 顺序无关那条说的是**结果**与输入顺序无关，不是可以随便乱序处理。
  /** @type {Array<{src: any, row: any, medium: string, status: string, auth: string}>} */
  const work = [];

  for (const src of sources) {
    stats.bundles += 1;
    const cs = src.crawlState;
    for (const row of src.index) {
      const isBroadcast = row.intent === 'broadcast.timeline';
      const lfKind = row.intent === 'note.item' ? 'note' : row.intent === 'review.item' ? 'review' : null;
      if (!isBroadcast && !lfKind && !row.intent?.startsWith('interest.list.')) continue;

      if (lfKind) {
        if (hasUnknownVerdict(row)) {
          warnings.push({ type: 'unknown_verdict', verdict: row.verdict, capture: row.capture_id });
          bump(stats.skipped, `未知 verdict:${row.verdict}`); continue;
        }
        if (!isContent(row)) {
          bump(stats.skipped, `verdict:${row.verdict}`);
          if (isRecalibratable(row)) bump(stats.recalibratable, row.route_key);
          continue;
        }
        work.push({ src, row, kind: 'longform', lfKind, auth: absenceAuthority(cs.get(row.route_key), src.status) });
        continue;
      }

      if (isBroadcast) {
        if (hasUnknownVerdict(row)) {
          warnings.push({ type: 'unknown_verdict', verdict: row.verdict, capture: row.capture_id });
          bump(stats.skipped, `未知 verdict:${row.verdict}`); continue;
        }
        if (!isContent(row)) {
          bump(stats.skipped, `verdict:${row.verdict}`);
          if (isRecalibratable(row)) bump(stats.recalibratable, row.route_key);
          continue;
        }
        work.push({ src, row, kind: 'broadcast', auth: absenceAuthority(cs.get(row.route_key), src.status) });
        continue;
      }

      const [, , medium, statusWord] = row.intent.split('.');
      const status = STATUS[statusWord];
      if (!status) { bump(stats.skipped, `未知状态词:${statusWord}`); continue; }

      if (hasUnknownVerdict(row)) {
        // 封闭词表出现新取值 = 生产者知道一种我们不认识的失败方式。当作判不出来。
        warnings.push({ type: 'unknown_verdict', verdict: row.verdict, capture: row.capture_id });
        bump(stats.skipped, `未知 verdict:${row.verdict}`);
        continue;
      }
      if (!isContent(row)) {
        bump(stats.skipped, `verdict:${row.verdict}`);
        if (isRecalibratable(row)) bump(stats.recalibratable, row.route_key);
        continue;
      }

      work.push({ src, row, kind: 'mark', medium, status, auth: absenceAuthority(cs.get(row.route_key), src.status) });
    }
  }
  work.sort((a, b) => (a.row.observed_at < b.row.observed_at ? -1 : 1));

  for (const { src, row, kind, lfKind, medium, status, auth } of work) {
    let html;
    try {
      html = src.payload(row);
    } catch (err) {
      warnings.push({ type: 'unreadable', capture: row.capture_id, error: String(err.message ?? err) });
      continue;
    }
    stats.pages += 1;

    const observationBase = {
      bundle_id: src.bundleId,
      capture_ids: [row.capture_id],
      observed_at: row.observed_at,
      absence_authority: auth,
      surface: row.surface ?? 'html',
    };

    if (kind === 'longform') {
      const lf = extractLongform(html, lfKind);
      if (!lf) {
        // 认不出来就报，**不猜**。正文页的结构是从真实抓取的字节里量出来的；
        // 认不出多半意味着豆瓣改版了，而那一页已经如实存进档案，改好重跑即可。
        warnings.push({ type: 'extractor_stale', capture: row.capture_id, kind: lfKind });
        src.close();
        continue;
      }
      stats.observations += 1;
      upsertLongform(longform, { lf, account: src.manifest?.account, observation: { ...observationBase }, parserVersion });
      src.close();
      continue;
    }

    if (kind === 'broadcast') {
      const owner = src.manifest?.account?.user_id;
      if (!owner) {
        // 不知道主人是谁就不抽——转发进来的是别人的广播，分不清就会把第三方内容
        // 写进档案主人的 canonical。
        warnings.push({ type: 'no_owner', capture: row.capture_id });
        continue;
      }
      const { broadcasts: bs, idless: bIdless } = extractBroadcasts(html, owner);
      if (bIdless > 0) {
        warnings.push({ type: 'extractor_stale', capture: row.capture_id, kind: 'broadcast', idless: bIdless });
      }
      for (const b of bs) {
        stats.observations += 1;
        upsertBroadcast(broadcasts, { b, account: src.manifest?.account, observation: { ...observationBase }, parserVersion });
      }
      src.close();
      continue;
    }

    const { marks: raw, idless } = extractMarks(html, medium);
    if (idless > 0) {
      // 容器在、有时间、却抽不到 id —— 抽取器跟不上页面了。**必须报**：
      // 静默跳过等于宣布「这一页就这么多」，而那是不可检测的丢失。
      warnings.push({ type: 'extractor_stale', capture: row.capture_id, medium, idless });
    }

    for (const m of raw) {
      stats.observations += 1;

      // 页面自己说的状态与路线说的对不上 —— 路线映射错了或页面变了。
      // 实测 2327 条全部吻合，所以一旦出现就值得看。
      if (m.relStatus && m.relStatus !== status) {
        warnings.push({
          type: 'status_mismatch', capture: row.capture_id,
          subject: m.subjectId, route: status, page: m.relStatus,
        });
      }

      const observation = { ...observationBase };

      upsertMark(marks, { m, medium, status, account: src.manifest?.account, observation, parserVersion, tz });
      upsertSubject(subjects, { m, medium, observation, parserVersion });
    }
    src.close();
  }

  return {
    marks: [...marks.values()],
    subjects: [...subjects.values()],
    broadcasts: [...broadcasts.values()],
    longform: [...longform.values()],
    warnings,
    stats,
  };
}

/** 身份分层。见 canonical/IDENTITY.md §2.3。 */
function identityOf(m, medium, accountId) {
  if (m.upstreamId) return { key: `u:${medium}:${m.upstreamId}`, layer: 'upstream_id' };
  // 退化键把状态迁移正确识别为同一条记录——那正是它存在的理由。
  return { key: `d:${accountId}:${medium}:${m.subjectId}`, layer: 'degraded_key' };
}

function upsertMark(store, { m, medium, status, account, observation, parserVersion, tz }) {
  const accountId = account?.user_id ?? 'unknown';
  const { key, layer } = identityOf(m, medium, accountId);

  const fields = {
    status,
    marked_at: m.date
      ? { raw: m.date, iso: `${m.date}T00:00:00+08:00`, precision: 'day', timezone_assumption: tz }
      : null,
    rating: m.rating,
    comment: m.comment,
    tags: m.tags,
    // **raw_meta 不放这里。**
    //
    // 它是作品目录数据，不是用户写的东西。放进标记的 fields 会让「豆瓣改了演员表」
    // 表现为「用户编辑了这条标记」——实测跑一遍就撞上了 3 条：34943576（配音演员
    // 换了一个）、37314835（上映日期从「2027(美国)」变成「2027(未定)」）、
    // 34430900（演员表调整）。三条的 status/rating/comment/tags 全都没动。
    //
    // 那正是这套设计从头到尾在防的「假编辑」，而且发生在最不该发生的地方：
    // 标记表存的是用户自己写的东西。权威的作品数据在 subjects.ndjson。
  };
  const digests = digestAll(fields);

  let rec = store.get(key);
  if (!rec) {
    rec = {
      canonical_version: CANONICAL_VERSION,
      identity_layer: layer,
      upstream_id: m.upstreamId ?? null,
      account: { user_id: accountId, username: account?.username ?? null },
      medium,
      subject: { id: m.subjectId, url: m.subjectUrl, upstream_deleted: m.upstreamDeleted },
      revisions: [],
    };
    store.set(key, rec);
  }
  // 上游 id 后来才出现（2023-12 起才有 data-cid）——补上，但不改身份层，
  // 因为这条记录此前是靠退化键攒起来的，说成 upstream_id 会掩盖那件事。
  if (!rec.upstream_id && m.upstreamId) rec.upstream_id = m.upstreamId;
  if (m.upstreamDeleted) rec.subject.upstream_deleted = true;

  appendRevision(rec.revisions, { fields, digests, observation, parserVersion });
}

function upsertSubject(store, { m, medium, observation, parserVersion }) {
  const key = `${medium}:${m.subjectId}`;
  const fields = {
    // 上游条目被删时，页面上写的「未知电影」是占位符，不是作品名。
    title: m.upstreamDeleted ? null : m.title,
    aliases: null,
    cover_url: m.coverUrl,
    raw_meta: m.rawMeta,
  };
  const digests = digestAll(fields);

  let rec = store.get(key);
  if (!rec) {
    rec = {
      canonical_version: CANONICAL_VERSION,
      medium,
      id: m.subjectId,
      url: m.subjectUrl,
      upstream_deleted: m.upstreamDeleted,
      revisions: [],
    };
    store.set(key, rec);
  }
  if (m.upstreamDeleted) rec.upstream_deleted = true;

  appendRevision(rec.revisions, { fields, digests, observation, parserVersion });
}

/**
 * **只在内容变了时追加一条修订。**
 *
 * 实测 2933 条标记 × 6 次抓取 ≈ 17600 次观测，真正的编辑只有 3 次。按观测追加会让
 * 99.98% 的行是噪音，而「这条什么时候变过」——canonical 存在的理由——反而要从噪音
 * 里筛出来。
 *
 * 观测本身没有丢：没变化的观测延长 `last_observed_at` 并追加进 `observations`。
 */
function appendRevision(revisions, { fields, digests, observation, parserVersion }) {
  const last = revisions[revisions.length - 1];

  // **只与同一个 parser_version 的修订比较。** 换了版本就必须开新修订——否则修好
  // 一个抽取 bug 会让四万条记录看起来像是同时被编辑过，而那不是编辑，是我们换了眼镜。
  if (last && last.parser_version === parserVersion && sameRevision(last.digests, digests)) {
    last.last_observed_at = observation.observed_at;
    last.observations.push(observation);
    return;
  }
  revisions.push({
    parser_version: parserVersion,
    first_observed_at: observation.observed_at,
    last_observed_at: observation.observed_at,
    fields,
    digests,
    observations: [observation],
  });
}

/**
 * 广播：身份是 `data-sid`，实测 100% 有，所以没有退化层。
 *
 * **它应当永远只有一条修订。** 广播发布后不可编辑——多出第二条修订不是「用户改了」，
 * 是抽取器或页面变了，值得去看。这一点与标记正好相反：标记有多条修订是正常的。
 */
function upsertBroadcast(store, { b, account, observation, parserVersion }) {
  const fields = {
    posted_at: b.postedAt
      ? { raw: b.postedAt, iso: b.postedAt.replace(' ', 'T') + '+08:00', precision: 'second', timezone_assumption: 'Asia/Shanghai' }
      : null,
    text: b.text,
    action: b.action,
    status: b.status,
    target_type: b.targetType,
    target_id: b.targetId,
  };
  const digests = digestAll(fields);

  let rec = store.get(b.sid);
  if (!rec) {
    rec = {
      canonical_version: CANONICAL_VERSION,
      identity_layer: 'upstream_id',
      upstream_id: b.sid,
      account: { user_id: account?.user_id ?? 'unknown', username: account?.username ?? null },
      url: b.url,
      revisions: [],
    };
    store.set(b.sid, rec);
  }
  appendRevision(rec.revisions, { fields, digests, observation, parserVersion });
}

/**
 * 日记与评论。
 *
 * **与广播相反：长文可以编辑**，所以多条修订是正常的，正是要留住的东西。
 * 而列表页上那份是截断摘要，只有正文页才有全文——这条路线的全部意义就在这儿。
 */
function upsertLongform(store, { lf, account, observation, parserVersion }) {
  const key = `${lf.kind}:${lf.id}`;
  const fields = {
    title: lf.title,
    published_at: lf.publishedAt
      ? { raw: lf.publishedAt, iso: lf.publishedAt.replace(' ', 'T') + '+08:00', precision: 'second', timezone_assumption: 'Asia/Shanghai' }
      : null,
    body: lf.body,
    rating: lf.rating,
    subject_url: lf.subjectUrl,
    location: lf.location,
  };
  const digests = digestAll(fields);

  let rec = store.get(key);
  if (!rec) {
    rec = {
      canonical_version: CANONICAL_VERSION,
      kind: lf.kind,
      identity_layer: 'upstream_id',
      upstream_id: lf.id,
      account: { user_id: account?.user_id ?? 'unknown', username: account?.username ?? null },
      url: lf.url,
      revisions: [],
    };
    store.set(key, rec);
  }
  appendRevision(rec.revisions, { fields, digests, observation, parserVersion });
}

function bump(obj, key) { obj[key] = (obj[key] ?? 0) + 1; }
