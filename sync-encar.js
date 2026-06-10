/**
 * ═══════════════════════════════════════════════════════
 *  SYNC AUTO-API.COM → SUPABASE — TaVoitureMoinsChère
 *  Fournisseur : auto-api.com (depuis 2017, aucune limite quota)
 *  Doc : https://auto-api.com/documentation
 *
 *  GitHub Secrets à configurer :
 *    AUTOAPI_KEY    → MEBkasK6mKDfJkAQ9499
 *    SUPABASE_URL   → https://xxxx.supabase.co
 *    SUPABASE_KEY   → service_role key
 *
 *  SQL Supabase à exécuter UNE FOIS avant le premier sync :
 *    ALTER TABLE voitures ADD COLUMN IF NOT EXISTS encar_id text UNIQUE;
 *    ALTER TABLE voitures ADD COLUMN IF NOT EXISTS source text DEFAULT 'manual';
 *    ALTER TABLE voitures ADD COLUMN IF NOT EXISTS last_seen_encar timestamptz;
 *
 *  Fonctionnement :
 *    - 1er sync : charge toutes les annonces via /offers (pages complètes)
 *    - Syncs suivants : récupère uniquement les changements via /changes
 *    - Résultat : quasi zéro requêtes inutiles, catalogue toujours à jour
 * ═══════════════════════════════════════════════════════
 */

require('dotenv').config();
const fetch  = require('node-fetch');
const fs     = require('fs');
const path   = require('path');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

// ── CONFIG ───────────────────────────────────────────────
const AUTOAPI_KEY  = process.env.AUTOAPI_KEY;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;

const API_BASE = 'https://api1.auto-api.com/api/v2/encar';

// Fichier local pour mémoriser le dernier change_id entre deux syncs
const CHANGE_ID_FILE = path.join(__dirname, '.last_change_id');

// ── 110 MODÈLES CIBLÉS TVMC ──────────────────────────────
// Format : { mark, model, year_from?, year_to? }
// Ces filtres sont passés directement à l'API /offers
const CIBLES = [
  // ── JAPONAISES ────────────────────────────────────────
  { mark: 'Toyota' },
  { mark: 'Nissan' },
  { mark: 'Honda' },
  { mark: 'Lexus' },
  { mark: 'Mitsubishi' },
  { mark: 'Mazda' },
  { mark: 'Subaru' },

  // ── AMÉRICAINES ───────────────────────────────────────
  { mark: 'Ford' },
  { mark: 'Dodge' },        // inclut Ram Pick Up
  { mark: 'Chevrolet' },
  { mark: 'Cadillac' },
  { mark: 'Jeep' },
  { mark: 'Hummer' },
  { mark: 'GMC' },

  // ── ALLEMANDES ────────────────────────────────────────
  { mark: 'Volkswagen' },
  { mark: 'BMW' },
  { mark: 'Mercedes-Benz' }, // inclut AMG
  { mark: 'Maybach' },
  { mark: 'Audi' },
  { mark: 'Porsche' },

  // ── ITALIENNES ────────────────────────────────────────
  { mark: 'Ferrari' },
  { mark: 'Lamborghini' },
  { mark: 'Maserati' },
  { mark: 'Alfa Romeo' },
  { mark: 'Fiat' },

  // ── BRITANNIQUES ──────────────────────────────────────
  { mark: 'Bentley' },
  { mark: 'Rolls-Royce' },
  { mark: 'Astonmartin' },  // nom exact Encar
  { mark: 'Jaguar' },
  { mark: 'Land Rover' },
  { mark: 'Lotus' },
  { mark: 'Mclaren' },      // nom exact Encar

  // ── FRANÇAISES ────────────────────────────────────────
  { mark: 'Peugeot' },

  // ── ÉLECTRIQUES ───────────────────────────────────────
  { mark: 'Tesla' },
  { mark: 'BYD' },
  { mark: 'Polestar' },
];

// ── HELPERS ─────────────────────────────────────────────
// Prix auto-api : unités de 10 000 KRW → EUR
function priceToEur(price) {
  if (!price) return 0;
  const krw = price * 10000;
  return Math.round(krw * 0.00067);
}

function mapCarburant(engine_type) {
  if (!engine_type) return 'Essence';
  const e = engine_type.toLowerCase();
  if (e.includes('diesel'))               return 'Diesel';
  if (e.includes('hybrid'))               return 'Hybride';
  if (e.includes('electric'))             return 'Electrique';
  if (e.includes('lpg') || e.includes('gpl')) return 'GPL';
  return 'Essence';
}

function mapTransmission(tr) {
  if (!tr) return 'Automatique';
  const t = tr.toLowerCase();
  if (t.includes('manual'))              return 'Manuelle';
  if (t.includes('cvt'))                 return 'CVT';
  if (t.includes('semi'))                return 'DCT';
  return 'Automatique';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// images peut être un Array ou une String JSON selon auto-api.com
function parseImages(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw === 'string') {
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter(Boolean) : [];
    } catch(e) {
      // URL unique en string
      return raw.startsWith('http') ? [raw] : [];
    }
  }
  return [];
}

// Supprimer le filigrane Encar de l'URL
function cleanImageUrl(url) {
  if (!url) return '';
  // Supprimer les paramètres de filigrane mais garder l'image de base
  return url.split('?')[0];
}

// ── REQUÊTE /offers ──────────────────────────────────────
async function fetchOffers(cible, page = 1) {
  const params = new URLSearchParams({ api_key: AUTOAPI_KEY, page });
  if (cible.mark)      params.append('mark',      cible.mark);
  if (cible.model)     params.append('model',     cible.model);
  if (cible.year_from) params.append('year_from', cible.year_from);
  if (cible.year_to)   params.append('year_to',   cible.year_to);

  const res = await fetch(`${API_BASE}/offers?${params}`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} — ${body.substring(0, 200)}`);
  }
  return res.json();
}

// ── REQUÊTE /changes ─────────────────────────────────────
async function fetchChanges(changeId) {
  const res = await fetch(`${API_BASE}/changes?api_key=${AUTOAPI_KEY}&change_id=${changeId}`);
  if (!res.ok) throw new Error(`/changes HTTP ${res.status}`);
  return res.json();
}

async function fetchChangeIdForDate(date) {
  const res = await fetch(`${API_BASE}/change_id?api_key=${AUTOAPI_KEY}&date=${date}`);
  if (!res.ok) throw new Error(`/change_id HTTP ${res.status}`);
  const json = await res.json();
  return json.change_id;
}

// ── TRANSFORMER → FORMAT SUPABASE ────────────────────────
function transformOffer(item) {
  const car = item.data || item;
  const marqueAffichage = (car.mark || '').replace('Mercedes-Benz', 'Mercedes');

  return {
    encar_id:            String(car.inner_id || car.id || ''),
    source:              'encar',
    marque:              marqueAffichage,
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
    description:         car.description || '',
    historique:          car.extra?.accidents?.length
      ? `Accidents: ${car.extra.accidents.length}`
      : '',
    photo_url:           cleanImageUrl(parseImages(car.images)[0] || ''),
    statut:              'pub',
    mode_vente:          'marche',
    homolog_ok:          false,
    homolog_autres_pays: true,
    export_possible:     true,
    frais_sup:           0,
    spec:                'Corée du Sud',
    last_seen_encar:     new Date().toISOString(),
    updated_at:          new Date().toISOString(),
  };
}

// ── UPSERT UN VÉHICULE ───────────────────────────────────
async function upsertVehicle(sb, item) {
  const car     = item.data || item;
  const encarId = String(car.inner_id || car.id || '');
  if (!encarId) return;

  const payload = transformOffer(item);

  const { error } = await sb
    .from('voitures')
    .upsert(payload, { onConflict: 'encar_id', ignoreDuplicates: false });

  if (error) {
    console.log(`    ❌ Upsert ${encarId}: ${error.message}`);
    return;
  }

  // Photos supplémentaires
  const imgs = parseImages(car.images);
  if (imgs.length > 1) {
    const { data: row } = await sb
      .from('voitures').select('id').eq('encar_id', encarId).single();
    if (row) {
      await sb.from('voiture_photos').delete().eq('voiture_id', row.id);
      // imgs déjà défini plus haut
      await sb.from('voiture_photos').insert(
        imgs.map((url, i) => ({ voiture_id: row.id, url: cleanImageUrl(url), position: i }))
      );
    }
  }
}

// ── SYNC INITIAL : toutes les annonces par modèle ────────
async function syncInitial(sb) {
  console.log('\n📥 MODE INITIAL — Chargement complet par modèle ciblé');
  let total = 0;

  for (const cible of CIBLES) {
    const label = cible.model ? `${cible.mark} ${cible.model}` : cible.mark;
    let page = 1;
    let pageTotal = 0;

    while (true) {
      let json;
      try {
        json = await fetchOffers(cible, page);
      } catch (err) {
        console.log(`  ⚠️  ${label} p.${page}: ${err.message}`);
        break;
      }

      const items = json.result || [];
      if (!items.length) break;

      for (const item of items) await upsertVehicle(sb, item);
      pageTotal += items.length;

      // Continuer si page suivante disponible
      if (!json.meta?.next_page) break;
      page++;
      await sleep(400);
    }

    if (pageTotal > 0) console.log(`  ✅ ${label}: ${pageTotal} annonces`);
    else console.log(`  ℹ️  ${label}: aucun résultat`);

    total += pageTotal;
    await sleep(300);
  }

  return total;
}

// ── SYNC INCRÉMENTAL : uniquement les changements ────────
async function syncIncremntal(sb, lastChangeId) {
  console.log(`\n🔄 MODE INCRÉMENTAL — changements depuis ID ${lastChangeId}`);
  let changeId   = lastChangeId;
  let added = 0, updated = 0, removed = 0;

  while (true) {
    let json;
    try {
      json = await fetchChanges(changeId);
    } catch (err) {
      console.log(`  ⚠️  /changes: ${err.message}`);
      break;
    }

    const changes = json.result || [];
    if (!changes.length) break;

    for (const change of changes) {
      const encarId = String(change.inner_id || '');
      if (!encarId) continue;

      if (change.change_type === 'removed') {
        // Annonce retirée → passer en draft
        await sb.from('voitures')
          .update({ statut: 'draft', updated_at: new Date().toISOString() })
          .eq('encar_id', encarId);
        removed++;
      } else if (change.change_type === 'changed') {
        // Mise à jour prix uniquement
        if (change.data?.new_price) {
          await sb.from('voitures')
            .update({
              prix:       priceToEur(change.data.new_price),
              updated_at: new Date().toISOString(),
              last_seen_encar: new Date().toISOString(),
            })
            .eq('encar_id', encarId);
          updated++;
        }
      } else if (change.change_type === 'added') {
        // Nouvelle annonce — vérifier si elle correspond à nos cibles
        const car = change.data || {};
        const isCible = CIBLES.some(c => {
          const markMatch = c.mark.toLowerCase() === (car.mark || '').toLowerCase();
          if (!markMatch) return false;
          // Si pas de modèle ciblé → toute la marque est acceptée
          if (!c.model) return true;
          return (car.model || '').toLowerCase().includes(c.model.toLowerCase());
        });
        if (isCible) {
          await upsertVehicle(sb, change);
          added++;
        }
      }
    }

    // Avancer dans le flux de changements
    changeId = json.meta?.next_change_id;
    if (!changeId || changes.length < 20) break;
    await sleep(200);
  }

  console.log(`  ✅ +${added} ajoutées | ~${updated} prix mis à jour | 🗑️ ${removed} retirées`);
  return changeId;
}

// ── LECTURE / ÉCRITURE DU DERNIER CHANGE_ID ─────────────
function readLastChangeId() {
  try {
    return parseInt(fs.readFileSync(CHANGE_ID_FILE, 'utf8').trim());
  } catch {
    return null;
  }
}

function saveLastChangeId(id) {
  fs.writeFileSync(CHANGE_ID_FILE, String(id));
}

// ── MAIN ────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();

  console.log('═══════════════════════════════════════════════════════');
  console.log(`🚀 SYNC AUTO-API.COM → SUPABASE — ${new Date().toLocaleString('fr-FR')}`);
  console.log(`📊 Fournisseur : auto-api.com | Aucune limite quota`);
  console.log(`⚙️  Modèles ciblés : ${CIBLES.length}`);
  console.log('═══════════════════════════════════════════════════════');

  if (!AUTOAPI_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Variables manquantes : AUTOAPI_KEY, SUPABASE_URL, SUPABASE_KEY');
    process.exit(1);
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { fetch: fetch },
    realtime: { transport: ws },
  });
  const lastChangeId = readLastChangeId();

  let totalSynced = 0;
  let newChangeId = null;

  if (!lastChangeId) {
    // ── PREMIER LANCEMENT : sync complet ──
    console.log('\n🆕 Premier lancement détecté → sync initial complet');
    totalSynced = await syncInitial(sb);

    // Récupérer le change_id d'aujourd'hui pour les prochains syncs
    const today = new Date().toISOString().split('T')[0];
    try {
      newChangeId = await fetchChangeIdForDate(today);
      saveLastChangeId(newChangeId);
      console.log(`\n💾 Change ID sauvegardé : ${newChangeId}`);
    } catch (e) {
      console.log(`  ⚠️  Impossible de récupérer le change_id: ${e.message}`);
    }
  } else {
    // ── SYNCS SUIVANTS : incrémental uniquement ──
    newChangeId = await syncIncremntal(sb, lastChangeId);
    if (newChangeId) {
      saveLastChangeId(newChangeId);
      console.log(`\n💾 Nouveau change ID sauvegardé : ${newChangeId}`);
    }
  }

  const duration = Math.round((Date.now() - startTime) / 1000);
  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`✅ SYNC TERMINÉE en ${duration}s`);
  if (totalSynced) console.log(`📦 ${totalSynced} véhicules chargés (sync initial)`);
  console.log(`⏰ Prochain sync dans 24h`);
  console.log('═══════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('💥 Erreur fatale:', err);
  process.exit(1);
});
