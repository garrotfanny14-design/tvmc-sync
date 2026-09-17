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

// ── TAUX DE CHANGE EN TEMPS RÉEL ─────────────────────
let KRW_RATE = null;
let JPY_RATE = null;

async function fetchRate(currency) {
  const apis = [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${currency.toLowerCase()}.min.json`,
    `https://open.er-api.com/v6/latest/${currency.toUpperCase()}`,
    `https://api.exchangerate-api.com/v4/latest/${currency.toUpperCase()}`,
  ];
  
  for (const url of apis) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      // Format fawazahmed0
      if (data[currency.toLowerCase()]?.eur) return data[currency.toLowerCase()].eur;
      // Format open.er-api
      if (data.rates?.EUR) return data.rates.EUR;
    } catch(e) { continue; }
  }
  return null;
}

async function fetchKrwRate() {
  if (KRW_RATE) return KRW_RATE;
  const rate = await fetchRate('krw');
  KRW_RATE = rate || (1 / 1520);
  const fallback = rate ? '' : ' (fallback)';
  console.log('💱 KRW->EUR: 1 KRW = ' + KRW_RATE.toFixed(8) + ' EUR (1 EUR = ' + Math.round(1/KRW_RATE) + ' KRW)' + fallback);
  return KRW_RATE;
}

async function fetchJpyRate() {
  if (JPY_RATE) return JPY_RATE;
  const rate = await fetchRate('jpy');
  JPY_RATE = rate || (1 / 163);
  const fallback = rate ? '' : ' (fallback)';
  console.log('💱 JPY->EUR: 1 JPY = ' + JPY_RATE.toFixed(8) + ' EUR (1 EUR = ' + Math.round(1/JPY_RATE) + ' JPY)' + fallback);
  return JPY_RATE;
}

// ── HELPERS ──────────────────────────────────────────────
function priceToEur(price, currency = 'KRW') {
  if (!price) return 0;
  if (currency === 'JPY') {
    // Auto-api retourne le prix JPY directement (pas ×10000)
    const rate = JPY_RATE || (1 / 163);
    return Math.round(price * rate);
  }
  // KRW : auto-api retourne en unités de 10 000 KRW
  const rate = KRW_RATE || (1 / 1520);
  return Math.round(price * 10000 * rate);
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
  const prixCalcule = priceToEur(car.price, car.price_currency || 'KRW');
  // Certaines annonces Encar (souvent du leasing/crédit "리스") ne communiquent
  // pas de prix de vente réel — l'API renvoie alors 0 ou une valeur dérisoire.
  const prixExploitable = car.price && prixCalcule >= 1000;
  // advertisementType (confirmé par le support auto-api.com) distingue une
  // vente classique (NORMAL, ~97% des annonces) des locations/leasings
  // (RENT_SUCCESSION, RENT_CAR, OPERATING_LEASE, FINANCING_LEASE) — pour ces
  // dernières, le "prix" correspond à un loyer, pas à la valeur du véhicule,
  // et n'est donc PAS comparable à un prix de vente. On ne garde que NORMAL.
  const estVenteNormale = !car.advertisementType || car.advertisementType === 'NORMAL';
  // salesStatus signale une vente déjà en cours (le véhicule va bientôt
  // disparaître d'Encar) — on ne le publie pas non plus.
  const venteEnCours = car.salesStatus === 'CONTRACT' || car.salesStatus === 'CONTRACT_PROGRESS';
  const devise = (car.price_currency === 'JPY' || car.country === 'JP') ? 'JPY' : 'KRW';
  // Prix brut en devise d'origine (avant conversion) — permet de recalculer
  // le prix EUR chaque jour avec le taux du jour, même si Encar ne signale
  // aucun changement de prix sur cette annonce (voir refresh_prix_devise).
  const prixOrigine = devise === 'JPY' ? (car.price || 0) : (car.price ? car.price * 10000 : 0);
  return {
    encar_id:            String(car.inner_id || car.id || ''),
    source:              'encar',
    marque:              (car.mark || '').replace('Mercedes-Benz', 'Mercedes'),
    // 'configuration' porte la finition (GT, Sport, Limited...) qui manquait —
    // sans elle, "Mustang GT" devenait juste "Mustang". Voir doc auto-api.com.
    modele:              [car.model, car.configuration].filter(Boolean).join(' ') || '',
    annee:               parseInt(car.year) || 2020,
    km:                  parseInt(car.km_age) || 0,
    prix:                prixCalcule,
    prix_origine:        prixOrigine,
    devise_origine:      devise,
    pays:                (car.price_currency === 'JPY' || car.country === 'JP') ? 'JP' : 'KR',
    carburant:           mapCarburant(car.engine_type),
    carbu:               mapCarburant(car.engine_type),
    transmission:        mapTransmission(car.transmission_type),
    cyl:                 parseInt(car.displacement) || 0,
    puissance:           parseInt(car.power || car.power_ice_hp) || 0,
    couleur_ext:         car.color || '',
    type_vehicule:       car.body_type || 'Berline',
    nb_portes:           4,
    etat_general:        'Bon',
    // 'options' (doc officielle auto-api.com/encar) = vraie liste d'équipements
    // structurée (toit ouvrant, sièges chauffants, etc.) — pas le texte de
    // vente du vendeur. 'complectation' testé précédemment était le mauvais champ.
    description:         Array.isArray(car.options) ? car.options.join(' - ') : '',
    // 'extra.accidents' (JSON structuré) donne l'historique accidents si dispo
    historique:           (car.extra && Array.isArray(car.extra.accidents))
                            ? (car.extra.accidents.length ? `${car.extra.accidents.length} accident(s) déclaré(s)` : 'Aucun accident déclaré')
                            : '',
    photo_url:           cleanImageUrl(parseImages(car.images)[0] || ''),
    statut:              (prixExploitable && estVenteNormale && !venteEnCours) ? 'pub' : 'draft',
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

// Conservée pour compatibilité (sync incrémental, véhicules ajoutés un par un — volume faible)
async function upsertVehicle(sb, item) {
  const car     = item.data || item;
  const encarId = String(car.inner_id || car.id || '');
  if (!encarId) return;

  const payload = transformOffer(item);
  const { data: row, error } = await sb.from('voitures')
    .upsert(payload, { onConflict: 'encar_id' })
    .select('id')
    .single();
  if (error) { console.log(`    ❌ ${encarId}: ${error.message}`); return; }

  // Photos
  const imgs = parseImages(car.images);
  if (imgs.length > 0 && row) {
    await sb.from('voiture_photos').delete().eq('voiture_id', row.id);
    await sb.from('voiture_photos').insert(
      imgs.slice(0, 20).map((url, i) => ({ voiture_id: row.id, url: cleanImageUrl(url), position: i }))
    );
  }
}

// ── VERSION BATCH — traite une page entière (N véhicules) en 3 requêtes DB
//    au lieu de N véhicules × 3 requêtes chacun. C'est ça qui divise la
//    charge sur Supabase par ~20-50x pour le sync initial/complet.
async function upsertVehiclesBatch(sb, items) {
  const valid = items.filter(item => {
    const car = item.data || item;
    return String(car.inner_id || car.id || '') !== '';
  });
  if (valid.length === 0) return;

  const payloads = valid.map(transformOffer);

  // 1 seul upsert pour toute la page, on récupère direct les id générés
  // (plus besoin d'un SELECT séparé par véhicule pour retrouver l'id)
  const { data: upserted, error } = await sb.from('voitures')
    .upsert(payloads, { onConflict: 'encar_id' })
    .select('id, encar_id');
  if (error) { console.log(`    ❌ batch upsert voitures: ${error.message}`); return; }

  const idByEncarId = new Map(upserted.map(r => [r.encar_id, r.id]));

  // Construire les lignes de photos pour TOUS les véhicules de la page
  const voitureIds = [];
  const photoRows  = [];
  for (const item of valid) {
    const car     = item.data || item;
    const encarId = String(car.inner_id || car.id || '');
    const voitureId = idByEncarId.get(encarId);
    if (!voitureId) continue;

    const imgs = parseImages(car.images);
    if (imgs.length === 0) continue;

    voitureIds.push(voitureId);
    imgs.slice(0, 20).forEach((url, i) => {
      photoRows.push({ voiture_id: voitureId, url: cleanImageUrl(url), position: i });
    });
  }

  if (voitureIds.length > 0) {
    // 1 seul DELETE pour toute la page (au lieu d'un par véhicule)
    const { error: delErr } = await sb.from('voiture_photos').delete().in('voiture_id', voitureIds);
    if (delErr) console.log(`    ⚠️  delete photos (batch): ${delErr.message}`);

    // 1 seul INSERT pour toute la page (au lieu d'un par véhicule)
    if (photoRows.length > 0) {
      const { error: insErr } = await sb.from('voiture_photos').insert(photoRows);
      if (insErr) console.log(`    ⚠️  insert photos (batch): ${insErr.message}`);
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

    await upsertVehiclesBatch(sb, items);
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
  let changeId = lastChangeId, added = 0, updated = 0, removed = 0, pages = 0;

  while (true) {
    let json;
    try {
      const res = await fetch(`${API_BASE}/changes?api_key=${AUTOAPI_KEY}&change_id=${changeId}`);
      if (!res.ok) { console.log(`  ⚠️  /changes HTTP ${res.status}`); break; }
      json = await res.json();
    } catch(err) { console.log(`  ⚠️  /changes: ${err.message}`); break; }

    const changes = json.result || [];
    if (!changes.length) break;

    // Traite tous les changements de la page EN PARALLÈLE (au lieu d'un par un,
    // séquentiellement) — réduit fortement le temps perdu en latence réseau
    // quand il y a un gros volume de changements à traiter.
    await Promise.all(changes.map(async (change) => {
      const encarId = String(change.inner_id || '');
      if (!encarId) return;
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
    }));

    pages++;
    const nextId = json.meta?.next_change_id;

    // ── CHECKPOINT CRITIQUE ─────────────────────────────────────────
    // On sauvegarde la progression à CHAQUE page traitée, pas seulement
    // à la toute fin. Si le job est interrompu (timeout GitHub Actions
    // à 180 min, panne réseau, etc.), le prochain run reprendra ici au
    // lieu de repartir de zéro et de re-timeout indéfiniment.
    if (nextId) saveLastChangeId(nextId);

    if (pages % 100 === 0) {
      console.log(`  … page ${pages} — +${added} | ~${updated} prix | 🗑️ ${removed} retirées (checkpoint: ${nextId})`);
    }

    changeId = nextId;
    if (!changeId || changes.length < 20) break;
    await sleep(50); // réduit de 200ms → 50ms : gain important sur un gros volume de pages
  }

  console.log(`  ✅ +${added} | ~${updated} prix | 🗑️ ${removed} retirées (${pages} pages)`);
  return changeId;
}

// ── EXCLUSION LEASING/VENTE-EN-COURS/DOUBLONS ────────────────────
// Endpoint dédié fourni par le support auto-api.com : renvoie directement
// les inner_id à exclure du catalogue, en plus du filtre advertisementType
// déjà appliqué à l'import (utile pour purger ce qui est déjà en base).
async function fetchExclusions() {
  try {
    const res = await fetch(`${API_BASE}/details?api_key=${AUTOAPI_KEY}`);
    if (!res.ok) { console.log(`  ⚠️  /details HTTP ${res.status}`); return null; }
    return await res.json();
  } catch (e) {
    console.log(`  ⚠️  /details: ${e.message}`);
    return null;
  }
}

async function applyExclusions(sb) {
  const details = await fetchExclusions();
  if (!details) return { rentLease: 0, contract: 0 };

  async function draftBatch(ids, label) {
    if (!ids || !ids.length) return 0;
    let total = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500).map(String);
      const { error, count } = await sb.from('voitures')
        .update({ statut: 'draft', updated_at: new Date().toISOString() }, { count: 'exact' })
        .eq('source', 'encar').eq('statut', 'pub').in('encar_id', chunk);
      if (error) { console.log(`  ⚠️  exclusion ${label}: ${error.message}`); continue; }
      total += count || 0;
    }
    return total;
  }

  const nbRentLease = await draftBatch(details.RENT_LEASE, 'RENT_LEASE');
  const nbContract  = await draftBatch(details.CONTRACT, 'CONTRACT');
  const nbDuplicate = await draftBatch(details.DUPLICATE, 'DUPLICATE');
  console.log(`🧹 Exclusions appliquées — ${nbRentLease} leasing/location, ${nbContract} vente en cours, ${nbDuplicate} doublons`);
  return { rentLease: nbRentLease, contract: nbContract, duplicate: nbDuplicate };
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

  // Récupérer les taux de change du jour (KRW et JPY)
  await Promise.all([fetchKrwRate(), fetchJpyRate()]);

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { fetch }, realtime: { transport: ws },
  });

  // ── RAFRAÎCHISSEMENT QUOTIDIEN DE TOUS LES PRIX ──────────────────
  // Recalcule le prix EUR de TOUTES les annonces publiées avec le taux
  // du jour, indépendamment du fait qu'Encar ait signalé un changement
  // de prix ou non. Évite qu'une annonce ancienne affiche un prix figé
  // au taux de change du jour de son dernier passage en base.
  // Fait par PETITS LOTS successifs (3000 lignes à la fois) pour éviter
  // le statement timeout sur un aussi gros volume (60 000+ annonces).
  async function refreshPricesLoop(devise, taux) {
    let total = 0, batch, iterations = 0;
    do {
      const { data, error } = await sb.rpc('refresh_prix_devise', { p_devise: devise, p_taux: taux, p_batch_size: 3000 });
      if (error) { console.log(`  ⚠️  refresh_prix_devise ${devise}: ${error.message}`); break; }
      batch = data || 0;
      total += batch;
      iterations++;
    } while (batch > 0 && iterations < 200); // garde-fou anti-boucle infinie
    return total;
  }

  try {
    const nbKrw = await refreshPricesLoop('KRW', 1 / KRW_RATE);
    const nbJpy = await refreshPricesLoop('JPY', 1 / JPY_RATE);
    console.log(`💰 Prix rafraîchis avec le taux du jour — ${nbKrw} annonces KRW, ${nbJpy} annonces JPY`);
  } catch (e) {
    console.log(`  ⚠️  Rafraîchissement des prix impossible: ${e.message}`);
  }

  // ── NETTOYAGE LEASING / VENTE-EN-COURS / DOUBLONS ────────────────
  // Purge ce qui a déjà été importé avant le filtre advertisementType,
  // et rattrape les annonces qui basculent en CONTRACT après coup.
  await applyExclusions(sb);

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
