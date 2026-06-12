const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

let puppeteer;
try {
  puppeteer = require("puppeteer-extra");
  const StealthPlugin = require("puppeteer-extra-plugin-stealth");
  puppeteer.use(StealthPlugin());
} catch {
  puppeteer = require("puppeteer");
}

const app = express();
app.use(cors());
app.use(express.json());

// ─── CONFIG ──────────────────────────────────────────────
const TMDB_KEY = "4e0d8acdbaf824338ac7bcf6a3ccfab6";
const PORT = process.env.PORT || 3000;
const HEADLESS = true;
const CACHE_TTL = 45 * 60 * 1000;
const NAV_TIMEOUT = 25000;
const WAIT_AFTER_LOAD = 2500;
const WAIT_AFTER_CLICK = 2000;
const WAIT_FOR_EMBED_CHANGE = 10000;

const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

let browser = null;
const cache = new Map();

// ─── REGEX ───────────────────────────────────────────────
const HOSTER_RX = /(vidzy\.live|vz-cdn|vidzy)/i;
const BAD_URL_RX = /(doubleclick|googlesyndication|googletagmanager|google-analytics|youtube|ytimg|googlevideo|facebook|fbcdn|disqus|popads|popcash|exoclick|adnxs|mgid|taboola|outbrain|adsterra|hilltopads|trafficjunky|propellerads)/i;
const VIDZY_EMBED_RX = /vidzy\.live\/embed-[a-z0-9]+\.html/i;

// ─── HELPERS ─────────────────────────────────────────────
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizeText(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}

function safeAbsUrl(url, base) {
  try {
    if (!url) return null;
    if (url.startsWith("//")) return "https:" + url;
    return new URL(url, base).href;
  } catch { return null; }
}

function isLikelyM3U8(url) { return !!url && /\.m3u8(\?|$)/i.test(url); }

function getVidzyId(url) {
  if (!url) return null;
  const m = url.match(/embed-([a-z0-9]+)\.html/i);
  return m ? m[1] : null;
}

function buildProxyM3U8(m3u8Url, embedUrl) {
  if (!m3u8Url || !embedUrl) return null;
  return `${PUBLIC_URL}/proxy/m3u8?url=${encodeURIComponent(m3u8Url)}&referer=${encodeURIComponent(embedUrl)}`;
}

// ─── JS UNPACKER ─────────────────────────────────────────
function unpackPACKER(html) {
  const results = [];
  const regex = /eval\(function\(p,a,c,k,e,d\)\{[^}]+\}\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:[^'\\]|\\.)*)'\s*\.split\s*\(\s*'\|'\s*\)/gs;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      let p = match[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\").replace(/\\n/g, "\n");
      const a = parseInt(match[2]); let c = parseInt(match[3]); const k = match[4].split("|");
      function encode(num) {
        const rem = num % a;
        const quot = Math.floor(num / a);
        const ch = rem > 35 ? String.fromCharCode(rem + 29) : rem.toString(36);
        return (num < a ? "" : encode(quot)) + ch;
      }
      while (c--) {
        if (k[c]) {
          const token = encode(c);
          try { p = p.replace(new RegExp("\\b" + token + "\\b", "g"), k[c]); } catch {}
        }
      }
      results.push(p);
    } catch {}
  }
  return results;
}

function extractM3U8FromText(text) {
  if (!text) return null;
  let m = text.match(/(https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*)/i);
  if (m) return m[1];
  m = text.match(/(?:file|source|src|video_url)\s*[:=]\s*["']([^"']+\.m3u8[^"']*)["']/i);
  if (m) return m[1].startsWith("//") ? "https:" + m[1] : m[1];
  return null;
}

// ─── BROWSER ─────────────────────────────────────────────
async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: HEADLESS,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      defaultViewport: { width: 1366, height: 900 },
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--mute-audio",
        "--disable-gpu",
        "--no-first-run"
      ]
    });
  }
  return browser;
}

async function preparePage(page, allowedHosts = [], opts = {}) {
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
  const headers = { "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8", "Accept": "text/html,*/*;q=0.8" };
  if (opts.referer) headers["Referer"] = opts.referer;
  await page.setExtraHTTPHeaders(headers);
  
  await page.evaluateOnNewDocument(() => {
    window.open = () => null;
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["fr-FR", "fr"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
  });
  
  await page.setRequestInterception(true);
  page.on("request", req => {
    try {
      const url = req.url();
      if (BAD_URL_RX.test(url)) return req.abort();
      const type = req.resourceType();
      if (opts.blockAssets && ["image", "font", "stylesheet", "media"].includes(type)) return req.abort();
      
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
        try {
          const host = new URL(url).hostname;
          if (allowedHosts.length && !allowedHosts.some(h => host.includes(h))) return req.abort();
        } catch {}
      }
      req.continue();
    } catch { try { req.continue(); } catch {} }
  });
}

async function getIframeEmbed(page) {
  return await page.evaluate(() => {
    const frames = Array.from(document.querySelectorAll("iframe"));
    const v = frames.find(f => f.src && f.src.includes("vidzy"));
    return v ? v.src : null;
  }).catch(() => null);
}

// ─── CLIC ÉPISODE ────────────────────────────────────────
async function clickEpisode(page, n, side) {
  const clicked = await page.evaluate((n, s) => {
    const isLeft = s === "left";
    const middle = window.innerWidth / 2;
    const all = Array.from(document.querySelectorAll("a, span, li, div, button"));
    
    const target = all.find(el => {
      const txt = el.innerText ? el.innerText.trim().toLowerCase() : "";
      const rect = el.getBoundingClientRect();
      if (rect.width < 5 || rect.width > 300) return false;
      if (rect.height < 10) return false;
      if (isLeft && rect.left > middle) return false;
      if (!isLeft && rect.left < middle - 50) return false;
      return txt === `episode ${n}` || txt === `episode 0${n}` || txt === `ep ${n}` || (txt === n.toString() && el.className && el.className.includes('ep'));
    });

    if (target) {
      target.scrollIntoView({ block: "center", behavior: "instant" });
      target.click();
      return true;
    }
    return false;
  }, n, side);
  return clicked;
}

// ─── EXTRACTION M3U8 ────────────────────────────────────
async function tryHttpM3U8(embedUrl, referer) {
  try {
    const r = await fetch(embedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36",
        "Referer": referer || "https://fs02.lol/",
        "Accept": "text/html,*/*"
      },
      timeout: 8000
    });
    if (!r.ok) return null;
    const html = await r.text();
    if (!html) return null;
    
    let m3u8 = extractM3U8FromText(html);
    if (m3u8) { console.log("  ⚡ M3U8 HTML direct"); return m3u8; }
    
    const unpacked = unpackPACKER(html);
    for (const code of unpacked) {
      m3u8 = extractM3U8FromText(code);
      if (m3u8) { console.log("  ⚡ M3U8 JS unpacké"); return m3u8; }
    }
    return null;
  } catch { return null; }
}

// ─── SCRAPE SÉRIE (OPTIMISÉ) ─────────────────────────────
async function scrapeSerie(serieUrl, episode, side = "left") {
  const t0 = Date.now();
  const b = await getBrowser();
  const page = await b.newPage();
  await preparePage(page, ["fs02.lol", "french-stream.ac"], { blockAssets: true });
  
  const store = { m3u8s: new Set() };
  page.on("request", req => { if (isLikelyM3U8(req.url())) store.m3u8s.add(req.url()); });

  try {
    console.log(`  Ouverture page série...`);
    await page.goto(serieUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(() => {});
    await wait(WAIT_AFTER_LOAD);

    const oldEmbed = await getIframeEmbed(page);
    const oldId = getVidzyId(oldEmbed);
    console.log(`  ID Episode actuel (auto): ${oldId || "aucun"}`);

    if (parseInt(episode) === 1 && oldEmbed) {
       console.log("  Episode 1 demandé et déjà chargé.");
    } else {
      console.log(`  Clic sur épisode ${episode}...`);
      await clickEpisode(page, episode, side);
      
      console.log(`  Attente du changement d'iframe (max ${WAIT_FOR_EMBED_CHANGE/1000}s)...`);
      let newEmbed = null;
      const startTime = Date.now();
      
      while (Date.now() - startTime < WAIT_FOR_EMBED_CHANGE) {
        await wait(500);
        newEmbed = await getIframeEmbed(page);
        if (newEmbed && getVidzyId(newEmbed) !== oldId) {
          console.log(`  ✅ Changement détecté ! Nouvel ID: ${getVidzyId(newEmbed)}`);
          break;
        }
      }
    }

    const finalEmbed = await getIframeEmbed(page);
    console.log(`  Embed Final: ${finalEmbed || "❌"}`);

    let m3u8 = null;
    if (finalEmbed) {
      store.m3u8s.clear();
      
      const r = await fetch(finalEmbed, { 
        headers: { 
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36",
          "Referer": serieUrl 
        },
        timeout: 8000
      }).then(res => res.text()).catch(() => "");
      
      m3u8 = extractM3U8FromText(r);
      if (!m3u8) {
        const unpacked = unpackPACKER(r);
        for (const code of unpacked) { 
          m3u8 = extractM3U8FromText(code); 
          if (m3u8) break; 
        }
      }

      if (!m3u8) {
        console.log("  🐢 Fallback Puppeteer pour M3U8...");
        await wait(3000);
        const embedId = getVidzyId(finalEmbed);
        m3u8 = Array.from(store.m3u8s).find(u => u.includes(embedId)) || Array.from(store.m3u8s)[0];
      }
    }

    await page.close();
    console.log(`  Page fermée (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

    return { embedUrl: finalEmbed, m3u8, lang: side === "left" ? "VF" : "VOSTFR" };

  } catch (e) {
    console.log("  Erreur:", e.message);
    try { await page.close(); } catch {}
    return { embedUrl: null, m3u8: null, lang: side === "left" ? "VF" : "VOSTFR" };
  }
}

// ─── TMDB & SEARCH ───────────────────────────────────────
async function getTmdbInfo(tmdbId) {
  const r = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_KEY}&language=fr-FR`);
  const d = await r.json();
  return {
    titre_fr: d.name,
    titre_original: d.original_name,
    annee: (d.first_air_date || "").slice(0, 4)
  };
}

// ─── FONCTION CORRIGÉE AVEC TOUS LES HEADERS ────────────
async function searchFrenchStream(query) {
  const r = await fetch("https://french-stream.ac/engine/ajax/search.php", {
    method: "POST",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Referer": "https://french-stream.ac/",
      "Origin": "https://french-stream.ac",
      "X-Requested-With": "XMLHttpRequest",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "Accept": "*/*",
      "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
      "Sec-Ch-Ua": '"Chromium";v="122", "Not(A:Brand";v="24"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Windows"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin"
    },
    body: "query=" + encodeURIComponent(query)
  });
  const html = await r.text();
  if (!html || html.length < 10) return [];
  
  const res = [];
  const re = /onclick="location\.href='([^']+)'[\s\S]*?<div class='search-title'>([^<]+)<\/div>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const p = m[1];
    res.push({ url: p.startsWith("http") ? p : "https://fs02.lol" + p, titre: m[2] });
  }
  return res;
}

function meilleurMatchSerie(resultats, titre, saison) {
  if (!resultats || !resultats.length) return null;
  const saisonTxt = `saison ${saison}`;
  const q = normalizeText(titre);
  const words = q.split(" ").filter(w => w.length > 2);
  
  let match = resultats.find(r => {
    const t = normalizeText(r.titre);
    return t.includes(saisonTxt) && words.every(w => t.includes(w));
  });
  if (match) return match;
  match = resultats.find(r => normalizeText(r.titre).includes(saisonTxt));
  return match || resultats[0];
}

// ─── PIPELINE PRINCIPAL ──────────────────────────────────
async function getSerieSources(tmdbId, saison, episode) {
  const t0 = Date.now();
  const info = await getTmdbInfo(tmdbId);
  console.log(`\n[TV] ${info.titre_fr} - S${saison}E${episode} (${info.annee})`);
  
  let resultats = await searchFrenchStream(`${info.titre_fr} Saison ${saison}`);
  if (!resultats.length && info.titre_original !== info.titre_fr) {
    resultats = await searchFrenchStream(`${info.titre_original} Saison ${saison}`);
  }
  
  const serie = meilleurMatchSerie(resultats, info.titre_fr, saison);
  if (!serie) return { ok: false, erreur: "Série non trouvée", titre: info.titre_fr };
  console.log("  Série:", serie.url);
  
  let res = await scrapeSerie(serie.url, episode, "left");
  if (!res.embedUrl && !res.m3u8) {
    console.log("  VF échoué, tentative VOSTFR...");
    res = await scrapeSerie(serie.url, episode, "right");
  }
  
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  RÉSULTAT: embed=${res.embedUrl ? "✅" : "❌"} m3u8=${res.m3u8 ? "✅" : "❌"} (${dt}s)`);
  
  if (!res.embedUrl && !res.m3u8) {
    return { ok: false, erreur: "Rien trouvé", titre: info.titre_fr, saison, episode };
  }
  
  const proxyM3U8 = buildProxyM3U8(res.m3u8, res.embedUrl);
  
  console.log(`  3 liens prêts:`);
  console.log(`    embedUrl  : ${res.embedUrl}`);
  console.log(`    m3u8      : ${res.m3u8 ? res.m3u8.slice(0, 60) + "..." : "❌"}`);
  console.log(`    proxyM3U8 : ${proxyM3U8 ? "✅" : "❌"}`);
  
  return {
    ok: true,
    titre: info.titre_fr,
    annee: info.annee,
    saison: parseInt(saison),
    episode: parseInt(episode),
    hosters: [{
      nom: "Vidzy",
      lang: res.lang || "VF",
      embedUrl: res.embedUrl || null,
      m3u8: res.m3u8 || null,
      proxyM3U8: proxyM3U8 || null,
      source: "french-stream"
    }]
  };
}

// ─── PROXY M3U8 ──────────────────────────────────────────
app.get("/proxy/m3u8", async (req, res) => {
  const { url, referer } = req.query;
  if (!url) return res.status(400).send("url manquante");
  try {
    const decodedUrl = decodeURIComponent(url);
    const decodedRef = referer ? decodeURIComponent(referer) : "https://vidzy.live/";
    const r = await fetch(decodedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 Chrome/122.0.0.0",
        "Referer": decodedRef,
        "Origin": new URL(decodedRef).origin
      }
    });
    if (!r.ok) return res.status(r.status).send("Erreur: " + r.status);
    const text = await r.text();
    const baseUrl = decodedUrl.replace(/\/[^\/]+$/, "/");
    const refEnc = referer || encodeURIComponent("https://vidzy.live/");
    const rewritten = text
      .replace(/^(?!#)(.+\.m3u8.*)$/gm, m => {
        const abs = m.trim().startsWith("http") ? m.trim() : baseUrl + m.trim();
        return `${PUBLIC_URL}/proxy/m3u8?url=${encodeURIComponent(abs)}&referer=${refEnc}`;
      })
      .replace(/^(?!#)(.+\.(ts|m4s|aac|mp4).*)$/gm, m => {
        const abs = m.trim().startsWith("http") ? m.trim() : baseUrl + m.trim();
        return `${PUBLIC_URL}/proxy/ts?url=${encodeURIComponent(abs)}&referer=${refEnc}`;
      });
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-cache");
    res.send(rewritten);
  } catch (e) { res.status(500).send("Erreur: " + e.message); }
});

// ─── PROXY TS ────────────────────────────────────────────
app.get("/proxy/ts", async (req, res) => {
  const { url, referer } = req.query;
  if (!url) return res.status(400).send("url manquante");
  try {
    const decodedUrl = decodeURIComponent(url);
    const decodedRef = referer ? decodeURIComponent(referer) : "https://vidzy.live/";
    const headers = {
      "User-Agent": "Mozilla/5.0 Chrome/122.0.0.0",
      "Referer": decodedRef,
      "Origin": new URL(decodedRef).origin
    };
    if (req.headers.range) headers["Range"] = req.headers.range;
    const r = await fetch(decodedUrl, { headers });
    if (!r.ok && r.status !== 206) return res.status(r.status).send("Erreur: " + r.status);
    const ct = r.headers.get("content-type") || "video/mp2t";
    const cl = r.headers.get("content-length");
    const cr = r.headers.get("content-range");
    res.setHeader("Content-Type", ct);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    if (cl) res.setHeader("Content-Length", cl);
    if (cr) { res.setHeader("Content-Range", cr); res.status(206); }
    r.body.pipe(res);
  } catch (e) { res.status(500).send("Erreur: " + e.message); }
});

// ─── ROUTES ──────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "ORION SERIES API",
    public_url: PUBLIC_URL,
    routes: [
      "GET /sources/tv/:tmdbId/:saison/:episode",
      "GET /proxy/m3u8?url=...&referer=...",
      "GET /proxy/ts?url=...&referer=..."
    ],
    response_format: {
      ok: true,
      titre: "string",
      annee: "string",
      saison: "number",
      episode: "number",
      hosters: [{
        nom: "Vidzy",
        lang: "VF/VOSTFR",
        embedUrl: "https://vidzy.live/embed-xxxxx.html",
        m3u8: "https://...vidzy.cc/...master.m3u8",
        proxyM3U8: "/proxy/m3u8?url=...&referer=... (À UTILISER)",
        source: "french-stream"
      }]
    }
  });
});

app.get("/sources/tv/:tmdbId/:saison/:episode", async (req, res) => {
  try {
    const { tmdbId, saison, episode } = req.params;
    const ck = `tv_${tmdbId}_s${saison}e${episode}`;
    
    if (cache.has(ck)) {
      const c = cache.get(ck);
      if (Date.now() - c.ts < CACHE_TTL) {
        console.log(`[CACHE] Série ${tmdbId} S${saison}E${episode}`);
        return res.json(c.data);
      }
      cache.delete(ck);
    }
    
    const data = await getSerieSources(tmdbId, saison, episode);
    
    if (data.ok && data.hosters[0]?.proxyM3U8) {
      cache.set(ck, { data, ts: Date.now() });
    }
    
    res.json(data);
  } catch (e) {
    res.json({ ok: false, erreur: e.message });
  }
});

// ─── DÉMARRAGE ───────────────────────────────────────────
app.listen(PORT, async () => {
  console.log("╔══════════════════════════════════════╗");
  console.log("║  ORION SERIES API — port " + PORT + "        ║");
  console.log("╚══════════════════════════════════════╝");
  console.log("  Mode HEADLESS:", HEADLESS);
  console.log("  Cache TTL:", CACHE_TTL / 60000, "min");
  console.log("  Public URL:", PUBLIC_URL);
  console.log("  Hoster: Vidzy uniquement");
  console.log("\n⚡ Chauffage navigateur...");
  await getBrowser();
  console.log("✅ Prêt !\n");
});
