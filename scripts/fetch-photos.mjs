#!/usr/bin/env node
// Récupère, pour chaque figure `data-wiki="Titre"` de voyage-japon-2026.html, l'image
// principale de l'article Wikipédia (images libres uniquement) et la dépose dans
// assets/img/<slug>.jpg, avec auteur et licence dans assets/img/CREDITS.md et un
// assets/img/manifest.json lu par la page. À lancer depuis une machine qui accède à
// Wikipédia :   node scripts/fetch-photos.mjs        (Node 18+, aucune dépendance)
//
// Options : --width=1000 (largeur max, défaut 1000) · --force (re-télécharge tout)
// Env FETCH_PHOTOS_NEWLIST=<fichier> : y ajoute le chemin de chaque image téléchargée (optimisation en CI).
// Photos perso : déposer assets/img/<slug>.jpg puis relancer le script, il complète
// le manifest sans écraser les fichiers existants (sauf --force).

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'voyage-japon-2026.html'), 'utf8');
const outDir = join(root, 'assets', 'img');
mkdirSync(outDir, { recursive: true });

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const WIDTH = Number(args.width) || 1000;
const FORCE = !!args.force;
const UA = 'japon2026-photos/1.0 (https://github.com/boukal1/japon2026; usage personnel)';

// même règle de slug que dans la page HTML
const slug = t => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// titres uniques par langue
const figs = [...html.matchAll(/<figure[^>]*data-wiki="([^"]+)"(?:[^>]*data-lang="([^"]+)")?/g)]
  .map(m => ({ title: m[1].replace(/_/g, ' ').trim(), lang: m[2] || 'en' }));
const byLang = {};
for (const f of figs) (byLang[f.lang] ??= new Set()).add(f.title);

const manifestPath = join(outDir, 'manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};

const sleep = ms => new Promise(r => setTimeout(r, ms));
// 3 tentatives, pause 2 s puis 6 s, sur erreur réseau ou 429/5xx
async function get(url, extra = {}) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Api-User-Agent': UA, ...extra } });
      if (r.ok) return r;
      last = new Error(`HTTP ${r.status}`);
      if (r.status !== 429 && r.status < 500) throw last;
    } catch (e) { last = e; }
    await sleep(i === 0 ? 2000 : 6000);
  }
  throw last;
}
async function api(host, params) {
  const url = `https://${host}/w/api.php?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`;
  return (await get(url)).json();
}

// 1) page image (nom de fichier + titre final) via l'API du wiki
async function pageImages(lang, titles) {
  const out = {}; // titre demandé -> { file, pageTitle }
  for (let i = 0; i < titles.length; i += 50) {
    const chunk = titles.slice(i, i + 50);
    const j = await api(`${lang}.wikipedia.org`, { action: 'query', redirects: '1', prop: 'pageimages', piprop: 'name', titles: chunk.join('|') });
    const alias = {};
    for (const n of j.query?.normalized ?? []) alias[n.from] = n.to;
    for (const r of j.query?.redirects ?? []) alias[r.from] = r.to;
    const pages = Object.fromEntries((j.query?.pages ?? []).map(p => [p.title, p]));
    for (const t of chunk) {
      let k = t, n = 0; while (alias[k] && n++ < 5) k = alias[k];
      const p = pages[k];
      if (p && !p.missing) out[t] = { file: p.pageimage || null, pageTitle: p.title, lang };
    }
  }
  return out;
}

// 1b) images de l'article dans l'ordre de la page (action=parse), pour trouver une vraie photo
const BAD = /logo|map|flag|icon|dimension|seal|emblem|locator|position|coat|diagram|plan|carte|blason|banner|button|symbol/i;
async function articleImages(lang, pageTitle) {
  try {
    const j = await api(`${lang}.wikipedia.org`, { action: 'parse', page: pageTitle, prop: 'images', redirects: '1' });
    return (j.parse?.images ?? []).filter(f => /\.jpe?g$/i.test(f) && !BAD.test(f));
  } catch { return []; }
}

// choisit le premier candidat qui est une photo JPEG d'au moins 800 px de large
async function pickPhoto(lang, pi) {
  const candidates = [];
  if (pi.file && /\.jpe?g$/i.test(pi.file) && !BAD.test(pi.file)) candidates.push(pi.file);
  for (const f of await articleImages(lang, pi.pageTitle)) if (!candidates.includes(f)) candidates.push(f);
  for (const file of candidates.slice(0, 6)) {
    const info = await fileInfo(lang, file);
    if (info && /jpeg/i.test(info.mime) && info.width >= 800) return { file, info };
  }
  return null;
}

// 2) URL redimensionnée + auteur/licence via l'API de Commons (le fichier peut aussi être local au wiki)
async function fileInfo(lang, file) {
  const q = { action: 'query', titles: `File:${file}`, prop: 'imageinfo', iiprop: 'url|extmetadata|mime|size', iiurlwidth: String(WIDTH) };
  let j = await api('commons.wikimedia.org', q);
  let p = j.query?.pages?.[0];
  if (!p || p.missing || !p.imageinfo) { j = await api(`${lang}.wikipedia.org`, q); p = j.query?.pages?.[0]; }
  const ii = p?.imageinfo?.[0];
  if (!ii) return null;
  const meta = ii.extmetadata ?? {};
  const strip = s => (s ?? '').replace(/<[^>]+>/g, '').trim();
  return {
    url: ii.thumburl || ii.url,
    page: ii.descriptionurl,
    mime: ii.mime,
    width: ii.width || 0,
    author: strip(meta.Artist?.value) || 'auteur non renseigné',
    license: strip(meta.LicenseShortName?.value) || 'licence non renseignée',
    licenseUrl: meta.LicenseUrl?.value || '',
  };
}

let ok = 0, skipped = 0, failed = [];
for (const [lang, set] of Object.entries(byLang)) {
  const titles = [...set];
  let imgs;
  try { imgs = await pageImages(lang, titles); } catch (e) { console.error(`✗ API ${lang}.wikipedia.org : ${e.message}`); process.exitCode = 1; continue; }
  for (const title of titles) {
    const s = slug(title);
    const dest = join(outDir, `${s}.jpg`);
    if (existsSync(dest) && !FORCE) {
      manifest[s] ??= { title, source: 'local', page: '', author: '', license: '' };
      skipped++; console.log(`· ${s}.jpg déjà présent`); continue;
    }
    const pi = imgs[title];
    if (!pi) { failed.push(`${title} (article introuvable)`); continue; }
    try {
      const chosen = await pickPhoto(lang, pi);
      if (!chosen) throw new Error("aucune photo JPEG ≥ 800 px dans l'article");
      const { file, info } = chosen;
      pi.file = file;
      const r = await get(info.url);
      const buf = Buffer.from(await r.arrayBuffer());
      writeFileSync(dest, buf);
      if (process.env.FETCH_PHOTOS_NEWLIST) appendFileSync(process.env.FETCH_PHOTOS_NEWLIST, dest + '\n');
      manifest[s] = { title, source: 'wikimedia', file: pi.file, page: info.page, author: info.author, license: info.license, licenseUrl: info.licenseUrl,
                      article: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(pi.pageTitle.replace(/ /g, '_'))}` };
      ok++; console.log(`✓ ${s}.jpg  (${Math.round(buf.length / 1024)} Ko, ${info.license}, ${info.author.slice(0, 40)})`);
    } catch (e) { failed.push(`${title} : ${e.message}`); }
  }
}

// fichiers déposés à la main, hors liste
for (const f of readdirSync(outDir)) {
  const m = f.match(/^(.+)\.(jpe?g|png|webp)$/i);
  if (m && !manifest[m[1]]) manifest[m[1]] = { title: m[1], source: 'local', page: '', author: '', license: '' };
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
const credits = ['# Crédits photos', '', 'Images de `assets/img/`, récupérées par `scripts/fetch-photos.mjs`. Les fichiers « local » ont été déposés à la main.', '',
  '| Fichier | Sujet | Auteur | Licence | Source |', '|---|---|---|---|---|',
  ...Object.entries(manifest).sort().map(([s, m]) => `| ${s}.jpg | ${m.title} | ${m.author || '—'} | ${m.licenseUrl ? `[${m.license}](${m.licenseUrl})` : (m.license || '—')} | ${m.page ? `[Commons](${m.page})` : (m.source === 'local' ? 'photo perso' : '—')} |`)];
writeFileSync(join(outDir, 'CREDITS.md'), credits.join('\n') + '\n');

console.log(`\n${ok} téléchargée(s), ${skipped} déjà présente(s), ${failed.length} échec(s).`);
for (const f of failed) console.log(`  ✗ ${f}`);
console.log('\nmanifest.json et CREDITS.md mis à jour → git add assets/img && git commit && git push');
