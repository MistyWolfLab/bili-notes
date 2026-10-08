#!/usr/bin/env node
// bili-notes - read a Bilibili video as text (title/desc/subtitles/danmaku/replies).
// No dependencies. Node >= 18.
//
//   node bili-notes.mjs BV1xxxx [-o out.md] [--danmaku 500] [--replies 20]
//   node bili-notes.mjs --search "关键词" [--n 10]
//
// Auth: anonymous (buvid3 cookie flow). No login needed for the endpoints used.
// Subtitles: only when the uploader enabled CC/AI subtitles; danmaku+replies
// are the main text source for most videos.
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function parse(argv) {
  const opt = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) opt[k] = argv[++i];
      else opt[k] = true;
    } else if (/^-[a-zA-Z]$/.test(a)) {
      const k = a.slice(1);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) opt[k] = argv[++i];
      else opt[k] = true;
    } else opt._.push(a);
  }
  return opt;
}
const opt = parse(process.argv.slice(2));

const H = (cookie = "", referer = "https://www.bilibili.com") => ({
  "User-Agent": UA,
  Referer: referer,
  "Accept-Language": "zh-CN,zh;q=0.9",
  ...(cookie ? { Cookie: cookie } : {}),
});

let _cookie = null;
async function cookie() {
  if (_cookie) return _cookie;
  const home = await fetch("https://www.bilibili.com/", { headers: H() });
  const jar = {};
  for (const c of home.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  _cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  return _cookie;
}
const get = async (url, referer) => {
  const r = await fetch(url, { headers: H(await cookie(), referer) });
  return r.json();
};

// ---- wbi signed search ----
const MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
let _wbiKey = null;
async function wbiKey() {
  if (_wbiKey) return _wbiKey;
  const nav = await get("https://api.bilibili.com/x/web-interface/nav");
  if (!nav.data?.wbi_img) throw new Error(`nav failed code=${nav.code} (no wbi_img)`);
  const img = nav.data.wbi_img.img_url.split("/").pop().split(".")[0];
  const sub = nav.data.wbi_img.sub_url.split("/").pop().split(".")[0];
  const enc = img + sub;
  _wbiKey = MIXIN.map((i) => enc[i]).join("").slice(0, 32);
  return _wbiKey;
}
async function search(keyword, n = 10) {
  const key = await wbiKey();
  const params = { keyword, search_type: "video", page: 1, wts: Math.floor(Date.now() / 1000) };
  const qs = Object.keys(params).sort().map((k) => `${k}=${encodeURIComponent(String(params[k])).replace(/[!'()*]/g, "")}`).join("&");
  const rid = createHash("md5").update(qs + key).digest("hex");
  const r = await get(
    `https://api.bilibili.com/x/web-interface/search/type?${qs}&w_rid=${rid}`,
    `https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}`
  );
  if (r.code !== 0) throw new Error(`search failed code=${r.code} msg=${r.message}`);
  return (r.data?.result ?? [])
    .filter((x) => x.bvid)
    .slice(0, n)
    .map((x) => ({
      bvid: x.bvid,
      title: String(x.title).replace(/<[^>]+>/g, ""),
      play: x.play,
      author: x.author,
      date: x.pubdate ? new Date(x.pubdate * 1000).toISOString().slice(0, 10) : "",
      duration: x.duration,
      desc: String(x.description ?? "").slice(0, 120),
    }));
}

// ---- per-video data ----
async function view(bvid) {
  const r = await get(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
  if (r.code !== 0) throw new Error(`view ${bvid} failed code=${r.code} msg=${r.message}`);
  return r.data;
}
async function subtitles(aid, cid, bvid) {
  const r = await get(`https://api.bilibili.com/x/player/v2?aid=${aid}&cid=${cid}`, `https://www.bilibili.com/video/${bvid}`);
  const subs = r?.data?.subtitle?.subtitles ?? [];
  if (!subs.length) return { available: false, lines: [] };
  const sj = await (await fetch("https:" + subs[0].subtitle_url, { headers: H() })).json();
  const lines = (sj.body ?? []).map((l) => ({ t: l.from, text: l.content }));
  return { available: true, lang: subs[0].lan + (subs[0].ai_status === 1 ? "(ai)" : ""), lines };
}
async function danmaku(cid, bvid, limit) {
  const r = await fetch(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`, {
    headers: H(await cookie(), `https://www.bilibili.com/video/${bvid}`),
  });
  const xml = await r.text();
  const msgs = [...xml.matchAll(/<d [^>]*>([^<]*)<\/d>/g)].map((m) => m[1]).filter(Boolean);
  // dedupe keep order, then sample evenly if too many
  const seen = new Set();
  const uniq = [];
  for (const m of msgs) if (!seen.has(m)) { seen.add(m); uniq.push(m); }
  const step = uniq.length > limit ? uniq.length / limit : 1;
  const sample = [];
  for (let i = 0; i < uniq.length && sample.length < limit; i += step) sample.push(uniq[Math.floor(i)]);
  return { total: msgs.length, unique: uniq.length, sample };
}
async function replies(aid, bvid, n) {
  const r = await get(`https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=2&ps=${Math.min(n, 20)}`, `https://www.bilibili.com/video/${bvid}`);
  const reps = r?.data?.replies ?? [];
  return reps.slice(0, n).map((x) => ({ like: x.like, msg: x.content?.message ?? "", rcount: x.rcount ?? 0 }));
}

// ---- markdown report ----
async function note(bvid) {
  const d = await view(bvid);
  const dmLimit = Number(opt.danmaku ?? 500);
  const repN = Number(opt.replies ?? 20);
  const out = [];
  out.push(`# ${d.title}`, "");
  out.push(`- BV: ${bvid}  UP: ${d.owner?.name}  分区: ${d.tname || "?"}`);
  out.push(`- 发布: ${new Date(d.pubdate * 1000).toISOString().slice(0, 10)}  播放: ${d.stat?.view}  弹幕: ${d.stat?.danmaku}  评论: ${d.stat?.reply}  赞: ${d.stat?.like}`);
  out.push(`- 时长: ${d.duration}s  分P: ${d.pages?.length ?? 1}`);
  out.push("", "## 简介", "", d.desc || "(无)", "");
  for (const pg of d.pages ?? []) {
    out.push(`## P${pg.page} ${pg.part || ""}`, "");
    const sub = await subtitles(d.aid, pg.cid, bvid);
    if (sub.available) {
      out.push(`### 字幕（${sub.lang}，${sub.lines.length} 行）`, "");
      out.push(sub.lines.map((l) => `[${l.t.toFixed(1)}s] ${l.text}`).join("\n"), "");
    } else {
      out.push("### 字幕", "", "（该视频未开启 CC/AI 字幕）", "");
    }
    const dm = await danmaku(pg.cid, bvid, dmLimit);
    out.push(`### 弹幕（共 ${dm.total} 条 / 去重 ${dm.unique} 条，采样 ${dm.sample.length} 条）`, "");
    out.push(dm.sample.map((m) => `- ${m}`).join("\n"), "");
  }
  const reps = await replies(d.aid, bvid, repN);
  out.push("## 热评（按点赞）", "");
  out.push(reps.map((r) => `- [${r.like}赞${r.rcount ? ` · ${r.rcount}回复` : ""}] ${r.msg.replace(/\n/g, " ")}`).join("\n"), "");
  return out.join("\n");
}

// ---- main ----
const die = (m) => { console.error(`[bili-notes] ${m}`); process.exit(1); };
try {
  if (opt.search) {
    const hits = await search(opt.search, Number(opt.n ?? 10));
    for (const h of hits) console.log(`${h.bvid}  ▶${h.play}  ${h.title}  — ${h.author} (${h.date})`);
    if (!hits.length) console.log("(no results)");
  } else if (opt._[0]) {
    const md = await note(opt._[0]);
    if (opt.o) {
      writeFileSync(opt.o, md, "utf8");
      console.log(`[bili-notes] written: ${opt.o} (${md.length} chars)`);
    } else {
      console.log(md);
    }
  } else {
    console.log(`bili-notes - read a bilibili video as text

  node bili-notes.mjs BV1xxxx [-o out.md] [--danmaku 500] [--replies 20]
  node bili-notes.mjs --search "关键词" [--n 10]

Anonymous access. Subtitles only when uploader enabled them;
danmaku + replies are the always-available text sources.`);
  }
} catch (e) {
  die(e.message);
}
