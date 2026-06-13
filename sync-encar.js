/**
 * SYNC AUTO-API.COM → SUPABASE — TaVoitureMoinsChère
 * Avec reprise automatique par marque (timeout-safe)
 */

require('dotenv').config();
const fetch  = require('node-fetch');
const fs     = require('fs');
const path   = require('path');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const AUTOAPI_KEY  = process.env.AUTOAPI_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const API_BASE     = 'https://api1.auto-api.com/api/v2/encar';

const CHANGE_ID_FILE  = path.join(__dirname, '.last_change_id');
const PROGRESS_FILE   = path.join(__dirname, '.sync_progress'); // marques déjà syncées

const CIBLES = [
  { mark: 'Toyota' }, { mark: 'Nissan' }, { mark: 'Honda' }, { mark: 'Lexus' },
  { mark: 'Mitsubishi' }, { mark: 'Mazda' }, { mark: 'Subaru' },
  { mark: 'Ford' }, { mark: 'Dodge' }, { mark: 'Chevrolet' }, { mark: 'Cadillac' },
  { mark: 'Jeep' }, { mark: 'Hummer' }, { mark: 'GMC' },
  { mark: 'Volkswagen' }, { mark: 'BMW' }, { mark: 'Mercedes-Benz' },
  { mark: 'Maybach' }, { mark: 'Audi' }, { mark: 'Porsche' },
  { mark: 'Ferrari' }, { mark: 'Lamborghini' }, { mark: 'Maserati' },
  { mark: 'Alfa Romeo' }, { mark: 'Fiat' },
  { mark: 'Bentley' }, { mark: 'Rolls-Royce' }, { mark: 'Astonmartin' },
  { mark: 'Jaguar' }, { mark: 'Land Rover' }, { mark: 'Lotus' }, { mark: 'Mclaren' },
  { mark: 'Peugeot' },
  { mark: 'Tesla' }, { mark: 'BYD' }, { mark: 'Polestar' },
];

// ── HELPERS ──────────────────────────────────────────────
function priceToEur(price) {
  if (!price) return 0;
  return Math.round(price * 10000 * 0.00067);
}

function mapCarburant(engine_type) {
  if (!engine_type) return 'Essence';
  const e = engine_type.toLowerCase();
  if (e.includes('diesel'))  return 'Diesel';
  if (e.includes('hybrid'))  return 'Hybride';
  if (e.includes('electric')) return 'Electrique';
  if (e.includes('lpg') || e.includes('gpl')) return 'GPL';
  return 'Essence';
}

function mapTransmission(tr) {
  if (!tr) return 'Automatique';
  const t = tr.toLowerCase();
  if (t.includes('manual')) return 'Manuelle';
  if (t.includes('cvt'))    return 'CVT';
  if (t.includes('semi'))   return 'DCT';
  return 'Automatique';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseImages(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw === 'string') {
    try { const a = JSON.parse(raw); return Array.isArray(a) ? a.filter(Boolean) : []; }
    catch(e) { return raw.startsWith('http') ? [raw] : []; }
  }
  return [];
}

function cleanImageUrl(url) {
  return url ? url.split('?')[0] : '';
}

function readLastChangeId() {
  try { return parseInt(fs.readFileSync(CHANGE_ID_FILE, 'utf8').trim()); }
  catch { return null; }
}

function saveLastChangeId(id) {
  fs.writeFileSync(CHANGE_ID_FILE, String(id));
}

// Marques déjà syncées (pour reprise après timeout)
function readProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); }
  catch { return { done: [] }; }
}

function saveProgress(done) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ done }));
}

function clearProgress() {
  try { fs.unlinkSync(PROGRESS_FILE); } catch {}
}

// ── TRANSFORM ────────────────────────────────────────────
function transformOffer(item) {
  const car = item.data || item;
  return {
    encar_id:            String(car.inner_id || car.id || ''),
    source:              'encar',
    marque:              (car.mark || '').replace('Mercedes-Benz', 'Mercedes'),
    modele:              car.model || '',
    annee:               parseInt(car.year) || 2020,
    km:                  parseInt(car.km_age) || 0,
    prix:                priceToEur(car.price),
    pays:                'KR',
    carburant:           mapCarburant(car.engine_type),
    carbu:               mapCarburant(car.engine_type),
    transmission:        mapTransmission(car.transmission_type),
    cyl:                 parseInt(car.displacement) || 0,
    puissance:           parseInt(car.power || car.power_ice_hp) || 0,
    couleur_ext:         car.color || '',
    type_vehicule:       car.body_type || 'Berline',
    nb_portes:           4,
    etat_general:        'Bon',
    description:         '',
    historique:          '',
    photo_url:           cleanImageUrl(parseImages(car.images)[0] || ''),
    statut:              'pub',
    mode_vente:          'marche',
    homolog_ok:          true,
    homolog_autres_pays: true,
    export_possible:     true,
    frais_sup:           0,
    spec:                'Corée du Sud',
    last_seen_encar:     new Date().toISOString(),
    updated_at:          new Date().toISOString(),
  };
}

async function upsertVehicle(sb, item) {
  const car     = item.data || item;
  const encarId = String(car.inner_id || car.id || '');
  if (!encarId) return;

  const payload = transformOffer(item);
  const { error } = await sb.from('voitures').upsert(payload, { onConflict: 'encar_id' });
  if (error) { console.log(`    ❌ ${encarId}: ${error.message}`); return; }

  // Photos
  const imgs = parseImages(car.images);
  if (imgs.length > 0) {
    const { data: row } = await sb.from('voitures').select('id').eq('encar_id', encarId).single();
    if (row) {
      await sb.from('voiture_photos').delete().eq('voiture_id', row.id);
      await sb.from('voiture_photos').insert(
        imgs.slice(0, 20).map((url, i) => ({ voiture_id: row.id, url: cleanImageUrl(url), position: i }))
      );
    }
  }
}

// ── SYNC UNE MARQUE ──────────────────────────────────────
async function syncMark(sb, cible) {
  const label = cible.model ? `${cible.mark} ${cible.model}` : cible.mark;
  let page = 1, total = 0;

  while (true) {
    const params = new URLSearchParams({ api_key: AUTOAPI_KEY, page });
    if (cible.mark)  params.append('mark',  cible.mark);
    if (cible.model) params.append('model', cible.model);

    let json;
    try {
      const res = await fetch(`${API_BASE}/offers?${params}`);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.log(`  ⚠️  ${label} p.${page}: HTTP ${res.status}`);
        break;
      }
      json = await res.json();
    } catch(err) {
      console.log(`  ⚠️  ${label} p.${page}: ${err.message}`);
      break;
    }

    const items = json.result || [];
    if (!items.length) break;

    for (const item of items) await upsertVehicle(sb, item);
    total += items.length;

    if (!json.meta?.next_page) break;
    page++;
    await sleep(300);
  }

  if (total > 0) console.log(`  ✅ ${label}: ${total} annonces`);
  else           console.log(`  ℹ️  ${label}: aucun résultat`);
  return total;
}

// ── SYNC INCRÉMENTAL ─────────────────────────────────────
async function syncIncremental(sb, lastChangeId) {
  console.log(`\n🔄 MODE INCRÉMENTAL — depuis change_id ${lastChangeId}`);
  let changeId = lastChangeId, added = 0, updated = 0, removed = 0;

  while (true) {
    let json;
    try {
      const res = await fetch(`${API_BASE}/changes?api_key=${AUTOAPI_KEY}&change_id=${changeId}`);
      if (!res.ok) { console.log(`  ⚠️  /changes HTTP ${res.status}`); break; }
      json = await res.json();
    } catch(err) { console.log(`  ⚠️  /changes: ${err.message}`); break; }

    const changes = json.result || [];
    if (!changes.length) break;

    for (const change of changes) {
      const encarId = String(change.inner_id || '');
      if (!encarId) continue;
      if (change.change_type === 'removed') {
        await sb.from('voitures').update({ statut: 'draft', updated_at: new Date().toISOString() }).eq('encar_id', encarId);
        removed++;
      } else if (change.change_type === 'changed' && change.data?.new_price) {
        await sb.from('voitures').update({ prix: priceToEur(change.data.new_price), updated_at: new Date().toISOString() }).eq('encar_id', encarId);
        updated++;
      } else if (change.change_type === 'added') {
        const car = change.data || {};
        const isCible = CIBLES.some(c => c.mark.toLowerCase() === (car.mark || '').toLowerCase());
        if (isCible) { await upsertVehicle(sb, change); added++; }
      }
    }

    changeId = json.meta?.next_change_id;
    if (!changeId || changes.length < 20) break;
    await sleep(200);
  }

  console.log(`  ✅ +${added} | ~${updated} prix | 🗑️ ${removed} retirées`);
  return changeId;
}

// ── MAIN ────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();
  console.log('═══════════════════════════════════════════════════════');
  console.log(`🚀 SYNC AUTO-API.COM → SUPABASE — ${new Date().toLocaleString('fr-FR')}`);
  console.log(`⚙️  Marques ciblées : ${CIBLES.length}`);
  console.log('═══════════════════════════════════════════════════════');

  if (!AUTOAPI_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Variables manquantes'); process.exit(1);
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { fetch }, realtime: { transport: ws },
  });

  const lastChangeId = readLastChangeId();

  if (!lastChangeId) {
    // ── PREMIER LANCEMENT ou reprise après timeout ──
    const progress = readProgress();
    const done = progress.done || [];
    const remaining = CIBLES.filter(c => !done.includes(c.mark));

    if (done.length === 0) {
      console.log('\n🆕 Premier lancement → sync initial complet');
      // Sauvegarder le change_id MAINTENANT avant de commencer (timeout-safe)
      try {
        const today = new Date().toISOString().split('T')[0];
        const res = await fetch(`${API_BASE}/change_id?api_key=${AUTOAPI_KEY}&date=${today}`);
        if (res.ok) {
          const j = await res.json();
          saveLastChangeId(j.change_id);
          console.log(`💾 Change ID pré-sauvegardé : ${j.change_id}`);
        }
      } catch(e) { console.log(`⚠️  change_id: ${e.message}`); }
    } else {
      console.log(`\n🔁 REPRISE — ${done.length}/${CIBLES.length} marques déjà syncées`);
    }

    console.log('\n📥 MODE INITIAL — Chargement par marque');
    let total = 0;

    for (const cible of remaining) {
      total += await syncMark(sb, cible);
      done.push(cible.mark);
      saveProgress(done); // Sauvegarder la progression après chaque marque
      await sleep(300);
    }

    // Tout terminé → effacer la progression
    clearProgress();
    console.log(`\n📦 ${total} véhicules chargés`);

  } else {
    // ── SYNCS QUOTIDIENS : incrémental ──
    const newId = await syncIncremental(sb, lastChangeId);
    if (newId) {
      saveLastChangeId(newId);
      console.log(`\n💾 Nouveau change ID : ${newId}`);
    }
  }

  const d = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n✅ SYNC TERMINÉE en ${d}s — Prochain sync dans 24h\n`);
}

main().catch(err => { console.error('💥', err); process.exit(1); });
