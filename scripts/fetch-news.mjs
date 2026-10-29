// Otaku Desk — news fetcher (runs in GitHub Actions, Node 20, no dependencies)
// Pulls RSS / Reddit / X posts, finds an image for every story, merges into data/news.json
import fs from "node:fs/promises";

const NEWS_FILE = "data/news.json";
const META_FILE = "data/meta.json";
const SOURCES_FILE = "data/sources.json";
const MAX_ITEMS = 400;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const DEFAULT_SOURCES = [
  { name: "SomosKudasai", type: "rss", url: "https://somoskudasai.com/feed/" },
  { name: "Automaton", type: "rss", url: "https://automaton-media.com/en/feed/" },
  { name: "SoraNews24", type: "rss", url: "https://soranews24.com/feed/" },
  { name: "Anime News Network", type: "rss", url: "https://www.animenewsnetwork.com/all/rss.xml?ann-edition=w", linkFilter: "/interest/" },
  { name: "Dexerto Anime", type: "rss", url: "https://www.dexerto.com/anime/feed/" }
];

const CATS = ["Cosplay", "VTuber", "Anime", "Game", "Manga", "Japan", "Viral"];
const CAT_RULES = [
  ["Cosplay", /cosplay|コスプレ|cosplayer|コスプレイヤー/i],
  ["VTuber", /vtuber|v-tuber|hololive|nijisanji|ホロライブ|にじさんじ|vtubers/i],
  ["Game", /\bgame|gaming|steam|nintendo|switch|playstation|ps5|xbox|gacha|ゲーム|juego|videojuego|capcom|bandai|sega|square enix|genshin|umamusume|ウマ娘/i],
  ["Manga", /manga|mangaka|マンガ|漫画|light novel|novela ligera|webtoon/i],
  ["Anime", /anime|アニメ|season|temporada|trailer|tráiler|episode|película/i],
  ["Japan", /japan|japón|japanese|japonés|tokyo|osaka|日本|idol|ídol/i]
];
const BOOST = /cosplay|コスプレ|vtuber|idol|ídol|viral|netizen|internautas|fans? (react|reacción)|controvers|polémica|polemica|girl|chica|waifu|gravure|x post|twitter|tweet|reddit|meme|ai\b|ia\b|weird|strange|insólit|funny|hilarious|backlash|arrest|arrestad|stole|robó|rumor|confess|revela|reveals|banned|prohib/gi;

/* ---------- helpers ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
function normUrl(u) {
  try { const x = new URL(u); x.hash = ""; ["utm_source", "utm_medium", "utm_campaign", "s", "t"].forEach(p => x.searchParams.delete(p)); if (/^(www\.)?(twitter|x)\.com$/.test(x.hostname)) x.hostname = "x.com"; return x.toString().replace(/\/$/, ""); }
  catch { return String(u || "").trim(); }
}
const idFor = url => "n" + hash(normUrl(url));
function decode(s = "") {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#039;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}
const strip = s => decode(s).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
function tag(block, name) { const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i")); return m ? m[1] : ""; }
function absUrl(u, base) { if (!u || !String(u).trim()) return ""; try { return new URL(decode(u), base).toString(); } catch { return ""; } }
function toMs(v) { if (!v) return 0; if (typeof v === "number") return v < 1e12 ? v * 1000 : v; const t = Date.parse(v); return isNaN(t) ? 0 : t; }
function guessCat(text) { for (const [c, re] of CAT_RULES) if (re.test(text)) return c; return "Viral"; }
function score(text) { return (text.match(BOOST) || []).length; }
async function get(url, { json = false, timeout = 20000 } = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, accept: json ? "application/json" : "*/*", "accept-language": "en,ja;q=0.8,es;q=0.6" }, signal: ctl.signal, redirect: "follow" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return json ? await r.json() : await r.text();
  } finally { clearTimeout(t); }
}
function goodImg(u) { return u && /^https?:\/\//.test(u) && !/\.(html?|php)(\?|$)/i.test(u) && !/gravatar|emoji|pixel|1x1|spacer|feedburner|logo\.(png|svg)/i.test(u); }

/* ---------- RSS ---------- */
async function fromRss(src) {
  const xml = await get(src.url);
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  const out = [];
  for (const b of blocks.slice(0, 30)) {
    const title = strip(tag(b, "title"));
    let link = strip(tag(b, "link")); if (!link) { const m = b.match(/<link[^>]+href="([^"]+)"/i); link = m ? m[1] : ""; }
    if (!title || !link) continue;
    if (src.linkFilter && !link.includes(src.linkFilter)) continue;
    const html = decode(tag(b, "content:encoded") || tag(b, "content") || "");
    const desc = strip(tag(b, "description") || tag(b, "summary") || html).slice(0, 700);
    const imgs = [];
    for (const m of b.matchAll(/<(?:media:content|media:thumbnail|enclosure)[^>]+url="([^"]+)"/gi)) imgs.push(absUrl(m[1], link));
    for (const m of (html + decode(tag(b, "description"))).matchAll(/<img[^>]+src="([^"]+)"/gi)) imgs.push(absUrl(m[1], link));
    const date = Date.parse(strip(tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date"))) || Date.now();
    out.push({ title, url: link, summary: desc, details: strip(html).slice(0, 6000), images: [...new Set(imgs.filter(goodImg))].slice(0, 6), source: src.name, origin: "web", publishedAt: date });
  }
  return out;
}

/* ---------- Reddit ---------- */
async function redditJson(url) {
  const u = new URL(url); const tries = [u.toString(), u.toString().replace("://www.reddit.com", "://old.reddit.com"), u.toString().replace("://www.reddit.com", "://api.reddit.com")];
  let last;
  for (const t of tries) { try { return await get(t, { json: true }); } catch (e) { last = e; await sleep(/429/.test(e.message) ? 6000 : 1500); } }
  throw last;
}
async function fromReddit(src) {
  let j;
  try { j = await redditJson(src.url); }
  catch (e) {
    // fallback: Atom feed (often allowed when JSON is blocked)
    const rss = src.url.replace(/\.json(\?|$)/, ".rss$1");
    const items = await fromRss({ ...src, url: rss });
    if (!items.length) throw e;
    return items.map(it => ({ ...it, origin: "reddit" }));
  }
  return (j?.data?.children || []).map(c => c.data).filter(d => !d.stickied && !d.over_18).map(d => mapReddit(d, src.name));
}
function mapReddit(d, name) {
  const imgs = [];
  if (d.preview?.images) for (const im of d.preview.images) imgs.push(decode(im.source?.url || ""));
  if (d.media_metadata) for (const k of Object.keys(d.media_metadata)) { const s = d.media_metadata[k]?.s; if (s?.u) imgs.push(decode(s.u)); }
  if (/\.(jpe?g|png|gif|webp)$/i.test(d.url || "")) imgs.push(d.url);
  return { title: decode(d.title), url: "https://www.reddit.com" + d.permalink, summary: (d.selftext || "").slice(0, 600), details: `${decode(d.title)}\n\n${d.selftext || ""}\n\nupvotes: ${d.ups} · comments: ${d.num_comments} · u/${d.author}`, images: [...new Set(imgs.filter(goodImg))].slice(0, 6), source: name || `Reddit r/${d.subreddit}`, origin: "reddit", publishedAt: (d.created_utc || 0) * 1000, likes: d.ups };
}
async function fromRedditPost(url) {
  const clean = url.split("?")[0].split("#")[0].replace(/\/$/, "").replace(/:\/\/(old|np|m|new)\.reddit\.com/, "://www.reddit.com");
  try {
    const j = await redditJson(clean + ".json");
    const d = j?.[0]?.data?.children?.[0]?.data; if (d) return mapReddit(d);
  } catch (e) { }
  // fallback: the post's Atom feed (first entry is the post itself)
  const xml = await get(clean + "/.rss");
  const b = (xml.match(/<entry[\s>][\s\S]*?<\/entry>/i) || [])[0]; if (!b) return null;
  const html = decode(tag(b, "content"));
  const imgs = [...html.matchAll(/href="(https:\/\/i\.redd\.it\/[^"]+)"/gi)].map(m => decode(m[1]));
  for (const m of html.matchAll(/<img[^>]+src="([^"]+)"/gi)) imgs.push(decode(m[1]));
  const thumb = (b.match(/<media:thumbnail[^>]+url="([^"]+)"/i) || [])[1]; if (thumb) imgs.push(decode(thumb));
  const sub = (clean.match(/\/r\/([^/]+)/) || [])[1] || "";
  const title = strip(tag(b, "title")); const text = strip(html);
  return { title, url: clean, summary: text.slice(0, 600), details: `${title}\n\n${text.slice(0, 4000)}\n\nโพสต์โดย ${strip(tag(b, "name"))}`, images: [...new Set(imgs.filter(goodImg))].slice(0, 6), source: `Reddit r/${sub}`, origin: "reddit", publishedAt: toMs(strip(tag(b, "published") || tag(b, "updated"))), likes: 0 };
}

/* ---------- HTML listing fallback (when a feed is blocked/empty) ---------- */
async function fromHtml(src) {
  const html = await get(src.htmlUrl);
  const re = new RegExp(src.linkPattern);
  const seen = new Set(); const out = [];
  for (const m of html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const link = absUrl(m[1], src.htmlUrl); const title = strip(m[2]);
    if (!re.test(link) || seen.has(link) || title.length < 20) continue;
    seen.add(link); out.push({ title, url: link, summary: "", details: "", images: [], source: src.name, origin: "web", publishedAt: 0 });
    if (out.length >= 20) break;
  }
  return out;
}

/* ---------- X (public embed data) ---------- */
function xToken(id) { return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, ""); }
async function fromX(url) {
  const id = (url.match(/status(?:es)?\/(\d+)/) || [])[1]; if (!id) return null;
  const t = await get(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${xToken(id)}`, { json: true });
  if (!t || !t.text) return null;
  const imgs = [];
  for (const m of t.mediaDetails || []) imgs.push(m.media_url_https);
  for (const p of t.photos || []) imgs.push(p.url);
  if (t.video?.poster) imgs.push(t.video.poster);
  if (t.card?.binding_values?.thumbnail_image_large?.image_value?.url) imgs.push(t.card.binding_values.thumbnail_image_large.image_value.url);
  const user = t.user || {};
  let text = (t.text || "").replace(/https:\/\/t\.co\/\w+/g, "").trim();
  const q = t.quoted_tweet;
  if (q?.text) { for (const m of q.mediaDetails || []) imgs.push(m.media_url_https); }
  const details = [
    `โพสต์ของ ${user.name || ""} (@ ${user.screen_name || ""}) — ${t.created_at || ""}`,
    text,
    `likes: ${t.favorite_count ?? "-"} · replies: ${t.conversation_count ?? "-"}`,
    q?.text ? `\nโพสต์ที่อ้างถึง (@ ${q.user?.screen_name || ""}):\n${q.text}` : "",
    t.video ? "(มีคลิปวิดีโอในโพสต์)" : ""
  ].filter(Boolean).join("\n");
  return {
    title: text.split("\n").filter(Boolean)[0]?.slice(0, 120) || `โพสต์ของ @${user.screen_name}`,
    url: `https://x.com/${user.screen_name || "i"}/status/${id}`,
    summary: text.slice(0, 600), details, images: [...new Set(imgs.filter(goodImg))].slice(0, 6),
    source: `X @ ${user.screen_name || ""}`, origin: "x", publishedAt: Date.parse(t.created_at) || Date.now(), likes: t.favorite_count || 0, lang: t.lang
  };
}

/* ---------- og:image backfill ---------- */
async function ogFill(item) {
  if (item.origin === "x") {
    const x = await fromX(item.url).catch(() => null);
    if (x) { item.images = x.images; if (!item.details) item.details = x.details; if (!item.summary) item.summary = x.summary; }
    return;
  }
  const html = await get(item.url, { timeout: 15000 });
  const meta = p => { const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]*content=["']([^"']+)["']`, "i")) || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${p}["']`, "i")); return m ? decode(m[1]) : ""; };
  const imgs = [meta("og:image"), meta("twitter:image"), meta("og:image:secure_url")].map(u => absUrl(u, item.url)).filter(goodImg);
  const body = (html.match(/<article[\s\S]*?<\/article>/i) || [html])[0];
  for (const m of body.matchAll(/<img[^>]+(?:data-src|src)="([^"]+)"/gi)) { const u = absUrl(m[1], item.url); if (goodImg(u) && !/avatar|icon|logo|ads?\//i.test(u)) imgs.push(u); if (imgs.length > 8) break; }
  item.images = [...new Set([...(item.images || []), ...imgs])].slice(0, 6);
  if (!item.summary) item.summary = meta("og:description") || meta("description");
  if (!item.title) item.title = meta("og:title") || meta("twitter:title") || strip((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
  if (!item.publishedAt) item.publishedAt = toMs(meta("article:published_time") || meta("og:published_time") || (html.match(/<time[^>]+datetime="([^"]+)"/i) || [])[1]);
  if (!item.details || item.details.length < 400) { const txt = strip(body).slice(0, 8000); if (txt.length > (item.details || "").length) item.details = txt; }
}

/* ---------- optional: Claude translates / sorts new items ---------- */
async function claudeEnrich(items) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key || !items.length) return;
  const H = { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" };
  let model = process.env.ANTHROPIC_MODEL;
  if (!model) {
    try { const r = await fetch("https://api.anthropic.com/v1/models?limit=50", { headers: H }); const j = await r.json(); const ids = (j.data || []).map(m => m.id); model = ids.find(i => /haiku/.test(i)) || ids.find(i => /sonnet/.test(i)) || ids[0]; } catch { }
  }
  if (!model) return;
  for (let i = 0; i < items.length; i += 15) {
    const batch = items.slice(i, i + 15);
    const list = batch.map((it, k) => `#${k}\nTITLE: ${it.title}\nSOURCE: ${it.source}\nTEXT: ${(it.summary || it.details || "").slice(0, 700)}`).join("\n\n");
    const prompt = `คุณคือบรรณาธิการเพจข่าวโอตาคุภาษาไทย (อนิเมะ เกม ญี่ปุ่น สาว ๆ คอสเพลย์ VTuber เรื่องไวรัล) สำหรับข่าวแต่ละข้อ ให้:
- title_th: พาดหัวภาษาไทยสั้น ชวนอ่าน (ไม่เกิน 90 ตัวอักษร)
- summary_th: สรุปภาษาไทย 2-3 ประโยค จากข้อมูลที่ให้เท่านั้น ห้ามแต่งเพิ่ม
- category: หนึ่งใน ${CATS.join("|")}
- fit: 0-10 ว่าเข้าแนวเพจแค่ไหน (เรื่องไวรัล ขำ แปลก ดราม่าเบา ๆ สาว ๆ คอสเพลย์ = สูง, ข่าวธุรกิจ/สเปคแห้ง ๆ = ต่ำ)
ตอบเป็น JSON array เท่านั้น เช่น [{"i":0,"title_th":"...","summary_th":"...","category":"Anime","fit":7}]

${list}`;
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: H, body: JSON.stringify({ model, max_tokens: 4000, messages: [{ role: "user", content: prompt }] }) });
      const j = await r.json(); const txt = (j.content || []).map(c => c.text || "").join("");
      const arr = JSON.parse(txt.slice(txt.indexOf("["), txt.lastIndexOf("]") + 1));
      for (const a of arr) { const it = batch[a.i]; if (!it) continue; if (a.title_th) { it.titleOriginal = it.title; it.title = a.title_th; } if (a.summary_th) { it.summaryOriginal = it.summary; it.summary = a.summary_th; } if (CATS.includes(a.category)) it.category = a.category; if (typeof a.fit === "number") it.fit = a.fit; }
    } catch (e) { console.log("claude enrich failed:", e.message); }
  }
}

/* ---------- free rough translation (MTL, Google Translate web endpoint, no API key) ---------- */
const isThai = s => /[฀-๿]/.test(s || "");
async function mtl(text) {
  text = String(text || "").trim(); if (!text) return "";
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch("https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=th&dt=t", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "user-agent": UA }, body: "q=" + encodeURIComponent(text), signal: ctl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json(); return (j?.[0] || []).map(s => s?.[0] || "").join("").trim();
  } finally { clearTimeout(t); }
}

/* ---------- main ---------- */
const readJson = async (f, d) => { try { return JSON.parse(await fs.readFile(f, "utf8")); } catch { return d; } };
const existing = await readJson(NEWS_FILE, []);
const sources = await readJson(SOURCES_FILE, DEFAULT_SOURCES);
const byId = new Map(existing.map(n => [n.id, n]));
const fresh = []; const errors = []; const counts = {};

for (const src of sources) {
  if (src.enabled === false) continue;
  try {
    let items = [];
    if (src.type === "reddit") { await sleep(5000); items = await fromReddit(src); }
    else if (src.type === "html") items = await fromHtml(src);
    else {
      try { items = await fromRss(src); } catch (e) { if (!src.htmlUrl) throw e; errors.push(`${src.name}: feed ${e.message} → ใช้หน้าเว็บแทน`); }
      if (!items.length && src.htmlUrl) items = await fromHtml(src);
      if (!items.length) throw new Error("feed ว่าง (อาจถูกบล็อก)");
    }
    let n = 0;
    for (const it of items) {
      const id = idFor(it.url); if (byId.has(id)) continue;
      const text = `${it.title} ${it.summary}`;
      const now = Date.now();
      const item = { id, ...it, url: normUrl(it.url), category: guessCat(text), score: score(text) + (src.type === "reddit" ? 1 : 0), status: "new", createdAt: now, fetchedAt: now };
      byId.set(id, item); fresh.push(item); n++;
    }
    counts[src.name] = n; console.log(`${src.name}: +${n}`);
  } catch (e) { errors.push(`${src.name}: ${e.message}`); console.log(`${src.name} failed: ${e.message}`); }
}

// links sent from the site or the daily scan (X + Reddit)
const links = (process.env.X_URLS || "").split(/[\s,]+/).filter(Boolean);
const xUrls = [...new Set(links.filter(u => /(x|twitter)\.com\/[^/]+\/status\/\d+/.test(u)).map(normUrl))];
const rUrls = [...new Set(links.filter(u => /reddit\.com\/r\/[^/]+\/comments\//.test(u)).map(u => u.replace(/:\/\/(old|np|m|new)\.reddit\.com/, "://www.reddit.com")).map(normUrl))];
let xAdded = 0, rAdded = 0;
function addItem(it, bonus = 3) {
  const realId = idFor(it.url);
  if (byId.has(realId)) { const old = byId.get(realId); if ((it.images || []).length) old.images = it.images; if (it.likes) old.likes = it.likes; if (it.publishedAt && !old.publishedAt) old.publishedAt = it.publishedAt; return false; }
  const now = Date.now();
  const item = { id: realId, ...it, url: normUrl(it.url), category: it.category && CATS.includes(it.category) ? it.category : guessCat(`${it.title} ${it.details || it.summary || ""}`), score: bonus + Math.min(5, Math.floor(Math.log10((it.likes || 1)))), status: "new", createdAt: now, fetchedAt: now };
  byId.set(realId, item); fresh.push(item); return true;
}
for (const u of xUrls) {
  try {
    const it = await fromX(u); await sleep(400);
    if (!it) { errors.push(`X ${u}: no data`); continue; }
    if (addItem(it)) xAdded++;
  } catch (e) { errors.push(`X ${u}: ${e.message}`); }
}
for (const u of rUrls) {
  try { const it = await fromRedditPost(u); await sleep(400); if (it && addItem(it)) rAdded++; }
  catch (e) { errors.push(`Reddit ${u}: ${e.message} (ส่งข้อมูลแบบ JSON แทนได้)`); }
}
// any other website link: read title / text / images / time from the page (skip what isn't there)
const wUrls = [...new Set(links.filter(u => /^https?:\/\//.test(u) && !/(x|twitter)\.com\/[^/]+\/status\/\d+/.test(u) && !/reddit\.com\/r\/[^/]+\/comments\//.test(u)).map(normUrl))];
let wAdded = 0;
for (const u of wUrls) {
  try {
    const it = { title: "", url: u, summary: "", details: "", images: [], source: new URL(u).hostname.replace(/^www\./, ""), origin: "web", publishedAt: 0 };
    await ogFill(it); it.imageTried = true; await sleep(300);
    if (!it.title) { errors.push(`${u}: อ่านหน้าเว็บไม่ได้`); continue; }
    if (addItem(it)) wAdded++;
  } catch (e) { errors.push(`${u}: ${e.message}`); }
}
// pre-scraped items (e.g. Reddit read in the logged-in browser by the daily scan)
let jAdded = 0;
try {
  const arr = JSON.parse(process.env.ITEMS_JSON || "[]");
  for (const x of Array.isArray(arr) ? arr : []) {
    if (!x?.title || !x?.url) continue;
    const it = { title: String(x.title).slice(0, 300), url: x.url, summary: String(x.summary || ""), details: String(x.details || x.summary || ""), images: (x.images || []).filter(goodImg).slice(0, 6), source: x.source || "", origin: /reddit\.com/.test(x.url) ? "reddit" : (/(x|twitter)\.com/.test(x.url) ? "x" : "web"), publishedAt: toMs(x.publishedAt), likes: +x.likes || 0 };
    if (addItem(it)) jAdded++;
  }
} catch (e) { errors.push("ITEMS_JSON: " + e.message); }
counts["X"] = xAdded; if (rUrls.length || rAdded) counts["Reddit links"] = rAdded; if (jAdded) counts["JSON"] = jAdded; if (wAdded) counts["ลิงก์เว็บ"] = wAdded;

// images + fuller text for anything still missing them (new first, then a few older)
const needImg = [...byId.values()].filter(n => !(n.images || []).length && !n.imageTried).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 45);
for (const it of needImg) { try { await ogFill(it); } catch (e) { } it.imageTried = true; await sleep(250); }
for (const it of fresh.filter(f => f.origin === "web" && (f.details || "").length < 400 && !needImg.includes(f)).slice(0, 25)) { try { await ogFill(it); } catch { } await sleep(250); }

await claudeEnrich(fresh.filter(f => !/[฀-๿]/.test(f.title)));

// rough MTL for anything not already in Thai (marked mtl: true)
let mtlDone = 0, mtlFail = 0;
const needMtl = [...byId.values()].filter(n => !isThai(n.title) && !n.mtlTitle).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 150);
for (const n of needMtl) {
  if (mtlFail >= 3) { errors.push("MTL: แปลไม่ได้ชั่วคราว จะลองใหม่รอบหน้า"); break; }
  try { n.mtlTitle = await mtl(n.title); const sm = (n.summary || "").slice(0, 1500); n.mtlSummary = sm ? await mtl(sm) : ""; n.mtl = true; mtlDone++; mtlFail = 0; await sleep(250); }
  catch (e) { mtlFail++; await sleep(1500); }
}
if (mtlDone) counts["MTL"] = mtlDone;
const all = [...byId.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || (b.score || 0) - (a.score || 0)).slice(0, MAX_ITEMS);
await fs.mkdir("data", { recursive: true });
await fs.writeFile(NEWS_FILE, JSON.stringify(all, null, 1));
await fs.writeFile(META_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), added: fresh.length, counts, errors, total: all.length, ai: !!process.env.ANTHROPIC_API_KEY }, null, 1));
console.log(`added ${fresh.length}, total ${all.length}, errors ${errors.length}`);
