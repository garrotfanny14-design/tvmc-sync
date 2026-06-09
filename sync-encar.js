/**
 * ═══════════════════════════════════════════════════════
 *  SYNC ENCAR → SUPABASE — TaVoitureMoinsChère
 *  Script Node.js à exécuter en cron toutes les heures
 *  
 *  Installation :
 *    1. Uploader ce fichier dans /public_html/auto/sync/
 *    2. Créer /public_html/auto/sync/.env avec tes clés
 *    3. Dans Hostinger hPanel → Cron Jobs → ajouter :
 *       0 * * * * cd /home/u279863079/public_html/auto/sync && node sync-encar.js >> sync.log 2>&1
 *
 *  Prérequis (dans /public_html/auto/sync/) :
 *    npm init -y
 *    npm install node-fetch @supabase/supabase-js dotenv
 * ═══════════════════════════════════════════════════════
 */

require('dotenv').config();
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

// ── CONFIG ──────────────────────────────────────────────
const CARAPIS_KEY   = process.env.CARAPIS_KEY;   // Ta clé Carapis dans .env
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_KEY;
const CARAPIS_BASE  = 'https://api.carapis.com/encar';

// ── 22 MARQUES À IMPORTER ───────────────────────────────
const MARQUES = [
  'Toyota', 'Nissan', 'Honda', 'Lexus', 'Mitsubishi',
  'Maserati', 'Volkswagen', 'Ford', 'Dodge', 'RAM',
  'Chevrolet', 'Cadillac', 'Jeep', 'BMW', 'Mercedes',
  'Audi', 'Porsche', 'Ferrari', 'Lamborghini', 'Bentley',
  'Rolls-Royce', 'Aston Martin'
];

// Correspondances noms anglais → noms Encar (coréen/anglais)
const MARQUE_MAP = {
  'Mercedes':     'Mercedes-Benz',
  'Rolls-Royce':  'Rolls Royce',
  'Aston Martin': 'Aston Martin',
  'RAM':          'Ram',
};

// ── CONVERSION KRW → EUR ────────────────────────────────
const KRW_TO_EUR = 0.00067; // Taux approximatif — met à jour régulièrement

function krwToEur(krw) {
  return Math.round((krw || 0) * KRW_TO_EUR);
}

// ── CORRESPONDANCE CARBURANT ────────────────────────────
function mapCarburant(fuel) {
  if (!fuel) return 'Essence';
  const f = fuel.toLowerCase();
  if (f.includes('diesel')) return 'Diesel';
  if (f.includes('hybrid') || f.includes('hybride')) return 'Hybride';
  if (f.includes('electric') || f.includes('electrique')) return 'Electrique';
  if (f.includes('lpg') || f.includes('gpl')) return 'GPL';
  return 'Essence';
}

// ── CORRESPONDANCE TRANSMISSION ─────────────────────────
function mapTransmission(tr) {
  if (!tr) return 'Automatique';
  const t = tr.toLowerCase();
  if (t.includes('manual') || t.includes('manuelle')) return 'Manuelle';
  if (t.includes('cvt')) return 'CVT';
  if (t.includes('dct') || t.includes('dsg')) return 'DCT';
  return 'Automatique';
}

// ── CYLINDRÉE EN CC DEPUIS ENGINE_SIZE ──────────────────
function engineToCc(engineSize) {
  if (!engineSize) return 0;
  // "2.0L" → 2000, "3.5L" → 3500
  const match = String(engineSize).match(/([\d.]+)\s*[lL]/);
  if (match) return Math.round(parseFloat(match[1]) * 1000);
  // Valeur directe en cc
  const num = parseInt(engineSize);
  if (num > 100) return num;
  return 0;
}

// ── REQUÊTE API CARAPIS ─────────────────────────────────
async function fetchEncar(brand, offset = 0) {
  const apiName = MARQUE_MAP[brand] || brand;
  const url = `${CARAPIS_BASE}/vehicles?brand=${encodeURIComponent(apiName)}&limit=100&offset=${offset}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${CARAPIS_KEY}` }
  });
  if (!res.ok) throw new Error(`API error ${res.status} pour ${brand}`);
  const json = await res.json();
  return json.data || {};
}

// ── TRANSFORMER UN VÉHICULE ENCAR → FORMAT SUPABASE ─────
function transformVehicle(car, marque) {
  const prixKRW = car.price || car.Price || 0;
  const prixEUR = krwToEur(prixKRW);

  return {
    // Identifiant externe pour éviter les doublons
    encar_id:        String(car.id || car.Id || ''),
    source:          'encar',

    // Infos véhicule
    marque:          marque,
    modele:          car.model || car.Model || car.title || '',
    annee:           parseInt(car.year || car.Year) || 2020,
    km:              parseInt(car.mileage || car.Mileage) || 0,
    prix:            prixEUR,
    pays:            'KR',

    // Specs
    carburant:       mapCarburant(car.fuel_type || car.FuelType),
    carbu:           mapCarburant(car.fuel_type || car.FuelType),
    transmission:    mapTransmission(car.transmission || car.Transmission),
    cyl:             engineToCc(car.engine_size || car.EngineSize),
    puissance:       parseInt(car.horsepower || car.Horsepower) || 0,
    couleur_ext:     car.color || car.Color || '',
    type_vehicule:   car.body_type || car.BodyType || 'Berline',
    nb_portes:       parseInt(car.doors || car.Doors) || 4,
    etat_general:    car.condition || 'Bon',

    // Description & historique
    description:     car.description || '',
    historique:      car.history ? `Accidents: ${car.history.accidents || 0} | Propriétaires: ${car.history.owners || 1}` : '',

    // Photo principale
    photo_url:       (car.images && car.images.length) ? car.images[0] : (car.image || ''),

    // Statut
    statut:          'pub',
    mode_vente:      'marche',
    homolog_ok:      false,  // À vérifier manuellement
    homolog_autres_pays: true,
    export_possible: true,
    frais_sup:       0,

    // Métadonnées
    spec:            'Corée du Sud',
    created_at:      new Date().toISOString(),
    updated_at:      new Date().toISOString(),
  };
}

// ── SYNC UNE MARQUE ─────────────────────────────────────
async function syncMarque(sb, marque) {
  console.log(`\n🔄 Syncing ${marque}...`);
  let offset = 0;
  let total = 0;
  let inserted = 0;
  let updated = 0;

  while (true) {
    let data;
    try {
      data = await fetchEncar(marque, offset);
    } catch (err) {
      console.log(`  ⚠️ Erreur API pour ${marque}: ${err.message}`);
      break;
    }

    const vehicles = data.vehicles || [];
    total = data.total || vehicles.length;

    if (!vehicles.length) break;

    for (const car of vehicles) {
      const encarId = String(car.id || car.Id || '');
      if (!encarId) continue;

      const payload = transformVehicle(car, marque);

      // Upsert : insert ou update si encar_id existe déjà
      const { error } = await sb
        .from('voitures')
        .upsert(payload, { onConflict: 'encar_id', ignoreDuplicates: false });

      if (error) {
        console.log(`  ❌ Erreur upsert ${encarId}: ${error.message}`);
      } else {
        inserted++;
      }

      // Sauvegarder les photos dans voiture_photos
      if (car.images && car.images.length > 1) {
        // On récupère l'ID Supabase du véhicule inséré
        const { data: row } = await sb
          .from('voitures')
          .select('id')
          .eq('encar_id', encarId)
          .single();

        if (row) {
          // Supprimer les anciennes photos
          await sb.from('voiture_photos').delete().eq('voiture_id', row.id);
          // Insérer les nouvelles
          const photos = car.images.map((url, i) => ({
            voiture_id: row.id,
            url,
            position: i
          }));
          await sb.from('voiture_photos').insert(photos);
        }
      }
    }

    offset += vehicles.length;
    console.log(`  ✅ ${offset}/${total} véhicules traités`);

    // Stop si on a tout récupéré
    if (offset >= total || vehicles.length < 100) break;

    // Petite pause pour ne pas surcharger l'API
    await new Promise(r => setTimeout(r, 500));
  }

  return inserted;
}

// ── SUPPRIMER LES ANNONCES RETIRÉES D'ENCAR ────────────
async function cleanupSupprimees(sb) {
  console.log('\n🧹 Vérification des annonces supprimées...');
  
  // Récupérer tous les encar_id actifs dans Supabase
  const { data: rows } = await sb
    .from('voitures')
    .select('id, encar_id')
    .eq('source', 'encar')
    .eq('statut', 'pub');

  if (!rows || !rows.length) return;

  let supprimees = 0;
  for (const row of rows) {
    // Vérifier si le véhicule existe encore sur Encar
    try {
      const res = await fetch(`${CARAPIS_BASE}/vehicle/${row.encar_id}`, {
        headers: { 'Authorization': `Bearer ${CARAPIS_KEY}` }
      });
      if (res.status === 404) {
        // Annonce supprimée → on passe en brouillon
        await sb.from('voitures').update({ statut: 'draft' }).eq('id', row.id);
        supprimees++;
        console.log(`  🗑️ Annonce ${row.encar_id} retirée (plus disponible sur Encar)`);
      }
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      // Ignorer les erreurs réseau
    }
  }

  console.log(`  ✅ ${supprimees} annonces retirées`);
}

// ── MAIN ─────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════');
  console.log(`🚀 SYNC ENCAR → SUPABASE — ${new Date().toLocaleString('fr-FR')}`);
  console.log('═══════════════════════════════════════════');

  if (!CARAPIS_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Variables .env manquantes. Vérifie CARAPIS_KEY, SUPABASE_URL, SUPABASE_KEY');
    process.exit(1);
  }

  // Vérifier si la colonne encar_id existe dans Supabase
  console.log('\n📋 Vérification de la structure Supabase...');
  console.log('   → Exécute ce SQL dans Supabase > SQL Editor si ce n\'est pas fait :');
  console.log('   ALTER TABLE voitures ADD COLUMN IF NOT EXISTS encar_id text UNIQUE;');
  console.log('   ALTER TABLE voitures ADD COLUMN IF NOT EXISTS source text DEFAULT \'manual\';');

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  let totalInserted = 0;

  for (const marque of MARQUES) {
    try {
      const n = await syncMarque(sb, marque);
      totalInserted += n;
    } catch (err) {
      console.log(`❌ Erreur sync ${marque}: ${err.message}`);
    }
  }

  // Nettoyage des annonces supprimées (1x par jour seulement, pas toutes les heures)
  const heure = new Date().getHours();
  if (heure === 3) { // Nettoyage à 3h du matin
    await cleanupSupprimees(sb);
  }

  console.log('\n═══════════════════════════════════════════');
  console.log(`✅ SYNC TERMINÉE — ${totalInserted} véhicules traités`);
  console.log(`⏰ Prochain sync dans 1 heure`);
  console.log('═══════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('💥 Erreur fatale:', err);
  process.exit(1);
});
