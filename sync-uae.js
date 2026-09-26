/**
 * SYNC DUBICARS + DUBIZZLE → SUPABASE — TaVoitureMoinsChère / Global Cars Export
 * Même architecture que sync-encar.js (checkpoints, batch, taux de change en direct)
 * Deux sources UAE traitées l'une après l'autre dans le même run.
 */

require('dotenv').config();
const fetch  = require('node-fetch');
const fs     = require('fs');
const path   = require('path');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const AUTOAPI_UAE_KEY = process.env.AUTOAPI_UAE_KEY;
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;

// Les deux sources UAE partagent exactement la même structure d'API
// (mêmes endpoints, mêmes champs, prix en AED) — voir auto-api.com/dubicars
// et auto-api.com/dubizzle.
const SOURCES = [
  { key: 'dubicars', label: 'Dubicars', prefix: 'DBC', apiBase: 'https://api1.auto-api.com/api/v2/dubicars' },
  { key: 'dubizzle', label: 'Dubizzle', prefix: 'DBZ', apiBase: 'https://api1.auto-api.com/api/v2/dubizzle' },
];

// Même liste de 36 marques que pour Encar (cohérence de gamme sur les deux sources).
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

// Certaines marques de CIBLES ont une orthographe différente selon la source
// (confirmé via le diagnostic /filters) — on garde CIBLES comme référentiel
// interne commun, et on traduit juste pour la requête API à chaque source.
const MARK_QUERY_OVERRIDES = {
  dubicars: {
    'Mercedes-Benz': 'Mercedes Benz',
    'Maybach':       'Mercedes Maybach',
    'Astonmartin':   'Aston Martin',
    'Rolls-Royce':   'Rolls Royce',
  },
  dubizzle: {
    'Maybach':       'Mercedes-Maybach',
    'Astonmartin':   'Aston Martin',
  },
};
function apiMarkFor(src, mark) {
  return (MARK_QUERY_OVERRIDES[src.key] && MARK_QUERY_OVERRIDES[src.key][mark]) || mark;
}

// ── TAUX DE CHANGE EN TEMPS RÉEL (AED → EUR) ─────────────────
// Même mécanisme que KRW/JPY dans sync-encar.js : 3 sources en cascade,
// avec repli sur un taux fixe si tout échoue (AED est arrimé au USD
// depuis 1997 à 1 USD = 3.6725 AED, donc ce repli reste raisonnable).
let AED_RATE = null;

async function fetchRate(currency) {
  const apis = [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${currency.toLowerCase()}.min.json`,
    `https://open.er-api.com/v6/latest/${currency.toUpperCase()}`,
    `https://api.exchangerate-api.com/v4/latest/${currency.toUpperCase()}`,
  ];
  for (const url of apis) {
    try {
      const res = await fetch(url, { timeout: 15000 });
      if (!res.ok) continue;
      const data = await res.json();
      if (data[currency.toLowerCase()]?.eur) return data[currency.toLowerCase()].eur;
      if (data.rates?.EUR) return data.rates.EUR;
    } catch (e) { continue; }
  }
  return null;
}

async function fetchAedRate() {
  if (AED_RATE) return AED_RATE;
  const rate = await fetchRate('aed');
  AED_RATE = rate || (1 / 4.00); // repli approximatif (1 EUR ≈ 4 AED début 2026)
  const fallback = rate ? '' : ' (fallback)';
  console.log('💱 AED->EUR: 1 AED = ' + AED_RATE.toFixed(8) + ' EUR (1 EUR = ' + Math.round(1 / AED_RATE) + ' AED)' + fallback);
  return AED_RATE;
}

// ── HELPERS ──────────────────────────────────────────────
function priceToEur(priceAed) {
  if (!priceAed) return 0;
  // Contrairement à Encar (prix en unités de 10 000 KRW), ces deux API
  // renvoient le prix directement en AED — pas de multiplicateur ici.
  return Math.round(priceAed * (AED_RATE || (1 / 4.00)));
}

function mapCarburant(engine_type) {
  if (!engine_type) return 'Essence';
  const e = engine_type.toLowerCase();
  if (e.includes('diesel'))   return 'Diesel';
  if (e.includes('hev') || e.includes('phev') || e.includes('hybrid')) return 'Hybride';
  if (e.includes('bev') || e.includes('electric')) return 'Electrique';
  return 'Essence';
}

function mapTransmission(tr) {
  if (!tr) return 'Automatique';
  const t = tr.toUpperCase();
  if (t === 'MT') return 'Manuelle';
  return 'Automatique';
}

// Uniformise l'orthographe de la marque quelle que soit la source (Dubicars
// et Dubizzle n'utilisent pas toujours les mêmes espaces/tirets) pour rester
// cohérent avec la liste de marques déjà utilisée par le filtre du site.
const MARQUE_NORMALISATION = {
  'Mercedes-Benz': 'Mercedes', 'Mercedes Benz': 'Mercedes',
  'Mercedes-Maybach': 'Maybach', 'Mercedes Maybach': 'Maybach',
  'Aston Martin': 'Astonmartin',
  'Rolls Royce': 'Rolls-Royce',
};
function normalizeMarque(raw) {
  const m = (raw || '').trim();
  return MARQUE_NORMALISATION[m] || m;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function cleanImageUrl(url) { return url ? url.split('?')[0] : ''; }

// L'API renvoie parfois 'images' comme une chaîne JSON ("[\"http://...\"]")
// au lieu d'un vrai tableau — sans cette fonction, car.images[0] sur une
// chaîne renvoie juste son 1er caractère ("["), pas une URL. Même bug que
// celui déjà géré côté Encar (sync-encar.js).
function parseImages(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw === 'string') {
    try { const a = JSON.parse(raw); return Array.isArray(a) ? a.filter(Boolean) : []; }
    catch (e) { return raw.startsWith('http') ? [raw] : []; }
  }
  return [];
}

// ── FICHIERS D'ÉTAT (un jeu par source) ──────────────────
function changeIdFile(source) { return path.join(__dirname, `.last_change_id_${source}`); }
function progressFile(source) { return path.join(__dirname, `.sync_progress_${source}`); }

function readLastChangeId(source) {
  try { return parseInt(fs.readFileSync(changeIdFile(source), 'utf8').trim()); }
  catch { return null; }
}
function saveLastChangeId(source, id) {
  fs.writeFileSync(changeIdFile(source), String(id));
}
function readProgress(source) {
  try { return JSON.parse(fs.readFileSync(progressFile(source), 'utf8')); }
  catch { return { done: [] }; }
}
function saveProgress(source, done) {
  fs.writeFileSync(progressFile(source), JSON.stringify({ done }));
}
function clearProgress(source) {
  try { fs.unlinkSync(progressFile(source)); } catch {}
}

// ── TRANSFORM ────────────────────────────────────────────
function transformOffer(item, src) {
  const car = item.data || item;
  const innerId = String(car.inner_id || car.id || '');
  const prixCalcule = priceToEur(car.price);
  // Pas de champ officiel équivalent à advertisementType (Encar) documenté
  // pour Dubicars/Dubizzle à ce jour — on garde le même filet de sécurité
  // que pour Encar (prix minimum) en attendant de voir si des annonces
  // anormalement basses (crédit/leasing) apparaissent dans la pratique.
  const prixExploitable = car.price && prixCalcule >= 500;

  return {
    encar_id:            `${src.prefix}-${innerId}`,
    source:              src.key,
    marque:              normalizeMarque(car.mark),
    modele:              [car.model, car.configuration].filter(Boolean).join(' ') || '',
    annee:               parseInt(car.year) || 2020,
    km:                  parseInt(car.km_age) || 0,
    prix:                prixCalcule,
    prix_origine:        car.price || 0,
    devise_origine:      'AED',
    pays:                'AE',
    carburant:           mapCarburant(car.engine_type),
    carbu:               mapCarburant(car.engine_type),
    transmission:        mapTransmission(car.transmission_type),
    cyl:                 parseInt(car.displacement) || 0,
    puissance:           parseInt(car.power) || 0,
    couleur_ext:         car.color || '',
    type_vehicule:       car.body_type || 'Berline',
    nb_portes:           parseInt(car.doors_count) || 4,
    etat_general:        'Bon',
    // 'description' (côté API) est le texte libre du vendeur, comme pour Encar
    // — pas une liste d'équipements exploitable, donc on ne la stocke pas.
    description:         '',
    historique:          '',
    photo_url:           cleanImageUrl(parseImages(car.images)[0] || ''),
    statut:              prixExploitable ? 'pub' : 'draft',
    mode_vente:          'marche',
    homolog_ok:          true,
    homolog_autres_pays: true,
    export_possible:     true,
    frais_sup:           0,
    spec:                'Émirats Arabes Unis',
    last_seen_encar:     new Date().toISOString(),
    updated_at:          new Date().toISOString(),
  };
}

// Conservée pour le sync incrémental (ajouts un par un, volume faible)
async function upsertVehicle(sb, item, src) {
  const car = item.data || item;
  const innerId = String(car.inner_id || car.id || '');
  if (!innerId) return;
  const payload = transformOffer(item, src);
  const { data: row, error } = await sb.from('voitures')
    .upsert(payload, { onConflict: 'encar_id' })
    .select('id')
    .single();
  if (error) { console.log(`    ❌ ${payload.encar_id}: ${error.message}`); return; }

  const imgs = parseImages(car.images);
  if (imgs.length > 0 && row) {
    await sb.from('voiture_photos').delete().eq('voiture_id', row.id);
    await sb.from('voiture_photos').insert(
      imgs.slice(0, 20).map((url, i) => ({ voiture_id: row.id, url: cleanImageUrl(url), position: i }))
    );
  }
}

// Version batch — traite une page entière (N véhicules) en 1 requête DB
// au lieu de N véhicules × 1 requête chacun (même logique que sync-encar.js).
async function upsertVehiclesBatch(sb, items, src) {
  const valid = items.filter(item => {
    const car = item.data || item;
    return String(car.inner_id || car.id || '') !== '';
  });
  if (valid.length === 0) return;

  const payloads = valid.map(item => transformOffer(item, src));

  // 1 seul upsert pour toute la page, on récupère direct les id générés
  const { data: upserted, error } = await sb.from('voitures')
    .upsert(payloads, { onConflict: 'encar_id' })
    .select('id, encar_id');
  if (error) { console.log(`    ❌ batch upsert ${src.label}: ${error.message}`); return; }

  const idByEncarId = new Map(upserted.map(r => [r.encar_id, r.id]));

  // ── Galerie photos (voiture_photos) — manquait dans la version initiale ──
  const voitureIds = [];
  const photoRows  = [];
  for (const item of valid) {
    const car = item.data || item;
    const innerId = String(car.inner_id || car.id || '');
    const voitureId = idByEncarId.get(`${src.prefix}-${innerId}`);
    if (!voitureId) continue;

    const imgs = parseImages(car.images);
    if (imgs.length === 0) continue;

    voitureIds.push(voitureId);
    imgs.slice(0, 20).forEach((url, i) => {
      photoRows.push({ voiture_id: voitureId, url: cleanImageUrl(url), position: i });
    });
  }

  if (voitureIds.length > 0) {
    const { error: delErr } = await sb.from('voiture_photos').delete().in('voiture_id', voitureIds);
    if (delErr) console.log(`    ⚠️  delete photos ${src.label} (batch): ${delErr.message}`);
    if (photoRows.length > 0) {
      const { error: insErr } = await sb.from('voiture_photos').insert(photoRows);
      if (insErr) console.log(`    ⚠️  insert photos ${src.label} (batch): ${insErr.message}`);
    }
  }
}

// ── SYNC UNE MARQUE (chargement initial) ─────────────────
async function syncMark(sb, src, cible) {
  const label = `${src.label} — ${cible.mark}`;
  let page = 1, total = 0;

  while (true) {
    const params = new URLSearchParams({ api_key: AUTOAPI_UAE_KEY, page, mark: apiMarkFor(src, cible.mark) });
    let json;
    try {
      const res = await fetch(`${src.apiBase}/offers?${params}`, { timeout: 20000 });
      if (!res.ok) {
        console.log(`  ⚠️  ${label} p.${page}: HTTP ${res.status}`);
        break;
      }
      json = await res.json();
    } catch (err) {
      console.log(`  ⚠️  ${label} p.${page}: ${err.message}`);
      break;
    }

    const items = json.result || [];
    if (!items.length) break;

    await upsertVehiclesBatch(sb, items, src);
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
async function syncIncremental(sb, src, lastChangeId) {
  console.log(`\n🔄 MODE INCRÉMENTAL ${src.label} — depuis change_id ${lastChangeId}`);
  let changeId = lastChangeId, added = 0, updated = 0, removed = 0, pages = 0;

  while (true) {
    let json;
    try {
      const res = await fetch(`${src.apiBase}/changes?api_key=${AUTOAPI_UAE_KEY}&change_id=${changeId}`, { timeout: 20000 });
      if (!res.ok) { console.log(`  ⚠️  /changes HTTP ${res.status}`); break; }
      json = await res.json();
    } catch (err) { console.log(`  ⚠️  /changes: ${err.message}`); break; }

    const changes = json.result || [];
    if (!changes.length) break;

    await Promise.all(changes.map(async (change) => {
      const innerId = String(change.inner_id || '');
      if (!innerId) return;
      const encarId = `${src.prefix}-${innerId}`;
      if (change.change_type === 'removed') {
        await sb.from('voitures').update({ statut: 'draft', updated_at: new Date().toISOString() }).eq('encar_id', encarId);
        removed++;
      } else if (change.change_type === 'changed' && change.data?.new_price) {
        await sb.from('voitures').update({ prix: priceToEur(change.data.new_price), prix_origine: change.data.new_price, updated_at: new Date().toISOString() }).eq('encar_id', encarId);
        updated++;
      } else if (change.change_type === 'added') {
        const car = change.data || {};
        const carMarkLower = (car.mark || '').toLowerCase();
        const isCible = CIBLES.some(c =>
          c.mark.toLowerCase() === carMarkLower ||
          apiMarkFor(src, c.mark).toLowerCase() === carMarkLower
        );
        if (isCible) { await upsertVehicle(sb, change, src); added++; }
      }
    }));

    pages++;
    const nextId = json.meta?.next_change_id;

    // Checkpoint à chaque page — reprend ici en cas d'interruption au lieu
    // de tout recommencer (même logique que syncIncremental d'Encar).
    if (nextId) saveLastChangeId(src.key, nextId);

    if (pages % 100 === 0) {
      console.log(`  … page ${pages} — +${added} | ~${updated} prix | 🗑️ ${removed} retirées (checkpoint: ${nextId})`);
    }

    changeId = nextId;
    if (!changeId || changes.length < 20) break;
    await sleep(50);
  }

  console.log(`  ✅ ${src.label}: +${added} | ~${updated} prix | 🗑️ ${removed} retirées (${pages} pages)`);
  return changeId;
}

// ── SYNC UNE SOURCE COMPLÈTE (dubicars OU dubizzle) ──────
async function syncSource(sb, src) {
  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(`📡 SOURCE : ${src.label}`);
  console.log(`═══════════════════════════════════════════════════════`);

  const lastChangeId = readLastChangeId(src.key);

  if (!lastChangeId) {
    const progress = readProgress(src.key);
    const done = progress.done || [];
    const remaining = CIBLES.filter(c => !done.includes(c.mark));

    if (done.length === 0) {
      console.log(`\n🆕 Premier lancement ${src.label} → sync initial complet`);
      try {
        const today = new Date().toISOString().split('T')[0];
        const res = await fetch(`${src.apiBase}/change_id?api_key=${AUTOAPI_UAE_KEY}&date=${today}`, { timeout: 15000 });
        if (res.ok) {
          const j = await res.json();
          saveLastChangeId(src.key, j.change_id);
          console.log(`💾 Change ID pré-sauvegardé : ${j.change_id}`);
        }
      } catch (e) { console.log(`⚠️  change_id: ${e.message}`); }
    } else {
      console.log(`\n🔁 REPRISE ${src.label} — ${done.length}/${CIBLES.length} marques déjà syncées`);
    }

    console.log(`\n📥 MODE INITIAL ${src.label} — Chargement par marque`);
    let total = 0;
    for (const cible of remaining) {
      total += await syncMark(sb, src, cible);
      done.push(cible.mark);
      saveProgress(src.key, done);
      await sleep(300);
    }
    clearProgress(src.key);
    console.log(`\n📦 ${src.label} : ${total} véhicules chargés`);
  } else {
    const newId = await syncIncremental(sb, src, lastChangeId);
    if (newId) {
      saveLastChangeId(src.key, newId);
      console.log(`\n💾 ${src.label} — Nouveau change ID : ${newId}`);
    }
  }
}

// ── MAIN ────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();
  console.log('═══════════════════════════════════════════════════════');
  console.log(`🚀 SYNC DUBICARS + DUBIZZLE → SUPABASE — ${new Date().toLocaleString('fr-FR')}`);
  console.log(`⚙️  Marques ciblées : ${CIBLES.length}`);
  console.log('═══════════════════════════════════════════════════════');

  if (!AUTOAPI_UAE_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Variables manquantes (AUTOAPI_UAE_KEY, SUPABASE_URL, SUPABASE_KEY)');
    process.exit(1);
  }

  await fetchAedRate();

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { fetch }, realtime: { transport: ws },
  });

  // ── DIAGNOSTIC : liste réelle des marques disponibles par source ──
  // Certaines marques de CIBLES ('Mercedes-Benz', 'Rolls-Royce', 'Astonmartin',
  // 'Maybach') sont remontées "aucun résultat" alors qu'elles existent bien
  // sur les sites — probablement une orthographe différente côté API par
  // rapport à ce qu'on utilise pour Encar. On liste ici les vraies valeurs
  // pour comparer et corriger CIBLES si besoin.
  for (const src of SOURCES) {
    try {
      const res = await fetch(`${src.apiBase}/filters?api_key=${AUTOAPI_UAE_KEY}`, { timeout: 15000 });
      if (res.ok) {
        const json = await res.json();
        const marques = Object.keys(json.mark || {}).sort();
        console.log(`\n🔎 ${src.label} — ${marques.length} marques disponibles côté API :`);
        // Par petits paquets pour ne jamais être tronqué par une limite de
        // longueur de ligne côté GitHub Actions (déjà arrivé une fois).
        for (let i = 0; i < marques.length; i += 10) {
          console.log('   ' + marques.slice(i, i + 10).join(', '));
        }
      } else {
        console.log(`  ⚠️  ${src.label} /filters HTTP ${res.status}`);
      }
    } catch (e) {
      console.log(`  ⚠️  ${src.label} /filters: ${e.message}`);
    }
  }

  // ── RATTRAPAGE PONCTUEL : marques dont l'orthographe vient d'être corrigée
  // Ces marques ont eu "aucun résultat" lors du tout premier sync (mauvaise
  // orthographe côté requête) — le mode incrémental ne les rattrapera JAMAIS
  // tout seul (il ne détecte que les nouvelles annonces, pas le stock déjà
  // existant avant le correctif). On les recharge une seule fois, puis on
  // ne retouche plus rien (marqueur de fichier).
  const CATCHUP_FILE = path.join(__dirname, '.catchup_marques_corrigees');
  if (!fs.existsSync(CATCHUP_FILE)) {
    const RATTRAPAGE = {
      dubicars: ['Mercedes-Benz', 'Maybach', 'Astonmartin', 'Rolls-Royce'],
      dubizzle: ['Astonmartin'],
    };
    console.log(`\n🩹 RATTRAPAGE PONCTUEL — marques corrigées (une seule fois)`);
    for (const src of SOURCES) {
      for (const mark of (RATTRAPAGE[src.key] || [])) {
        await syncMark(sb, src, { mark });
        await sleep(300);
      }
    }
    fs.writeFileSync(CATCHUP_FILE, new Date().toISOString());
    console.log(`✅ Rattrapage terminé — ne se relancera plus`);
  }

  for (const src of SOURCES) {
    try {
      await syncSource(sb, src);
    } catch (err) {
      console.log(`❌ Erreur sync ${src.label}: ${err.message}`);
    }
  }

  const d = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n✅ SYNC UAE TERMINÉE en ${d}s — Prochain sync dans 24h\n`);
}

main().catch(err => { console.error('💥', err); process.exit(1); });
