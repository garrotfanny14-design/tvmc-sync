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
  // ── FORD ──────────────────────────────────────────────
  { mark: 'Ford', model: 'Mustang',    year_from: 2015, year_to: 2024 },
  { mark: 'Ford', model: 'F-150',      year_from: 2010, year_to: 2024 },
  { mark: 'Ford', model: 'Expedition', year_from: 2018, year_to: 2024 },
  { mark: 'Ford', model: 'Bronco',     year_from: 2021, year_to: 2024 },

  // ── RAM ───────────────────────────────────────────────
  { mark: 'RAM',  model: '1500',       year_from: 2010, year_to: 2024 },

  // ── DODGE ─────────────────────────────────────────────
  { mark: 'Dodge', model: 'Challenger' },
  { mark: 'Dodge', model: 'Charger' },
  { mark: 'Dodge', model: 'Durango' },

  // ── CHEVROLET ─────────────────────────────────────────
  { mark: 'Chevrolet', model: 'Camaro',   year_from: 2010, year_to: 2024 },
  { mark: 'Chevrolet', model: 'Corvette' },
  { mark: 'Chevrolet', model: 'Tahoe' },
  { mark: 'Chevrolet', model: 'Suburban' },
  { mark: 'Chevrolet', model: 'Silverado' },

  // ── CADILLAC ──────────────────────────────────────────
  { mark: 'Cadillac', model: 'Escalade' },

  // ── JEEP ──────────────────────────────────────────────
  { mark: 'Jeep', model: 'Wrangler',      year_from: 2007, year_to: 2024 },
  { mark: 'Jeep', model: 'Gladiator' },
  { mark: 'Jeep', model: 'Grand Cherokee' },

  // ── VOLKSWAGEN ────────────────────────────────────────
  { mark: 'Volkswagen', model: 'Golf R' },

  // ── BMW ───────────────────────────────────────────────
  { mark: 'BMW', model: 'M2' },
  { mark: 'BMW', model: 'M3' },
  { mark: 'BMW', model: 'M4' },
  { mark: 'BMW', model: 'M5' },
  { mark: 'BMW', model: 'X5 M' },
  { mark: 'BMW', model: 'X6 M' },
  { mark: 'BMW', model: 'M8' },

  // ── MERCEDES-BENZ ─────────────────────────────────────
  { mark: 'Mercedes-Benz', model: 'C-Class',   }, // C63 AMG
  { mark: 'Mercedes-Benz', model: 'E-Class',   }, // E63 AMG
  { mark: 'Mercedes-Benz', model: 'CLS-Class', }, // CLS63
  { mark: 'Mercedes-Benz', model: 'G-Class',   }, // G63, G350, G400
  { mark: 'Mercedes-Benz', model: 'S-Class',   }, // S63, S560
  { mark: 'Mercedes-Benz', model: 'Maybach',   }, // Maybach S560, S650

  // ── AUDI ──────────────────────────────────────────────
  { mark: 'Audi', model: 'RS3' },
  { mark: 'Audi', model: 'RS4' },
  { mark: 'Audi', model: 'RS5' },
  { mark: 'Audi', model: 'RS6' },
  { mark: 'Audi', model: 'RS7' },
  { mark: 'Audi', model: 'R8' },
  { mark: 'Audi', model: 'SQ5' },
  { mark: 'Audi', model: 'SQ7' },
  { mark: 'Audi', model: 'SQ8' },
  { mark: 'Audi', model: 'RS Q8' },

  // ── PORSCHE ───────────────────────────────────────────
  { mark: 'Porsche', model: 'Cayman' },
  { mark: 'Porsche', model: 'Boxster' },
  { mark: 'Porsche', model: '911' },
  { mark: 'Porsche', model: 'Panamera' },
  { mark: 'Porsche', model: 'Cayenne' },

  // ── NISSAN ────────────────────────────────────────────
  { mark: 'Nissan', model: '350Z' },
  { mark: 'Nissan', model: '370Z' },
  { mark: 'Nissan', model: 'GT-R' },
  { mark: 'Nissan', model: 'Silvia' },
  { mark: 'Nissan', model: 'Skyline' },

  // ── TOYOTA ────────────────────────────────────────────
  { mark: 'Toyota', model: 'Land Cruiser' },
  { mark: 'Toyota', model: 'Land Cruiser Prado' },

  // ── LEXUS ─────────────────────────────────────────────
  { mark: 'Lexus', model: 'IS F' },
  { mark: 'Lexus', model: 'GS F' },
  { mark: 'Lexus', model: 'RC F' },
  { mark: 'Lexus', model: 'LC' },
  { mark: 'Lexus', model: 'LX' },

  // ── HONDA ─────────────────────────────────────────────
  { mark: 'Honda', model: 'Civic Type R' },
  { mark: 'Honda', model: 'S2000' },
  { mark: 'Honda', model: 'NSX' },

  // ── MAZDA ─────────────────────────────────────────────
  { mark: 'Mazda', model: 'RX-7' },
  { mark: 'Mazda', model: 'RX-8' },
  { mark: 'Mazda', model: 'MX-5' },

  // ── MITSUBISHI ────────────────────────────────────────
  { mark: 'Mitsubishi', model: 'Lancer Evolution' },
  { mark: 'Mitsubishi', model: 'Pajero' },

  // ── SUBARU ────────────────────────────────────────────
  { mark: 'Subaru', model: 'Impreza WRX STI' },
  { mark: 'Subaru', model: 'Levorg' },

  // ── BENTLEY ───────────────────────────────────────────
  { mark: 'Bentley', model: 'Continental GT' },
  { mark: 'Bentley', model: 'Flying Spur' },
  { mark: 'Bentley', model: 'Bentayga' },

  // ── ROLLS-ROYCE ───────────────────────────────────────
  { mark: 'Rolls-Royce', model: 'Ghost' },
  { mark: 'Rolls-Royce', model: 'Wraith' },
  { mark: 'Rolls-Royce', model: 'Dawn' },

  // ── MASERATI ──────────────────────────────────────────
  { mark: 'Maserati', model: 'GranTurismo' },
  { mark: 'Maserati', model: 'GranCabrio' },
  { mark: 'Maserati', model: 'Levante' },

  // ── FERRARI ───────────────────────────────────────────
  { mark: 'Ferrari', model: 'F430' },
  { mark: 'Ferrari', model: '458' },
  { mark: 'Ferrari', model: 'California' },
  { mark: 'Ferrari', model: 'F12' },

  // ── LAMBORGHINI ───────────────────────────────────────
  { mark: 'Lamborghini', model: 'Gallardo' },
  { mark: 'Lamborghini', model: 'Huracan' },
  { mark: 'Lamborghini', model: 'Urus' },

  // ── ASTON MARTIN ──────────────────────────────────────
  { mark: 'Aston Martin', model: 'DB9' },
  { mark: 'Aston Martin', model: 'Vantage' },
  { mark: 'Aston Martin', model: 'DB11' },
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
    photo_url:           Array.isArray(car.images) && car.images.length
      ? car.images[0]
      : '',
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
  if (Array.isArray(car.images) && car.images.length > 1) {
    const { data: row } = await sb
      .from('voitures').select('id').eq('encar_id', encarId).single();
    if (row) {
      await sb.from('voiture_photos').delete().eq('voiture_id', row.id);
      await sb.from('voiture_photos').insert(
        car.images.map((url, i) => ({ voiture_id: row.id, url, position: i }))
      );
    }
  }
}

// ── SYNC INITIAL : toutes les annonces par modèle ────────
async function syncInitial(sb) {
  console.log('\n📥 MODE INITIAL — Chargement complet par modèle ciblé');
  let total = 0;

  for (const cible of CIBLES) {
    const label = `${cible.mark} ${cible.model}`;
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
        const isCible = CIBLES.some(c =>
          c.mark.toLowerCase() === (car.mark || '').toLowerCase() &&
          (car.model || '').toLowerCase().includes(c.model.toLowerCase())
        );
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

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
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
