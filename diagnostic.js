/**
 * DIAGNOSTIC — Noms exacts des modèles sur Encar
 * Appelle /filters pour chaque marque problématique
 * et affiche les modèles disponibles
 * 
 * Usage : node diagnostic.js
 */

require('dotenv').config();
const fetch = require('node-fetch');

const AUTOAPI_KEY = process.env.AUTOAPI_KEY || 'MEBkasK6mKDfJkAQ9499';
const API_BASE    = 'https://api1.auto-api.com/api/v2/encar';

// Marques à investiguer
const MARQUES_A_CHECKER = [
  'Ford',
  'Ram',
  'Dodge',
  'Chevrolet',
  'Jeep',
  'Volkswagen',
  'BMW',
  'Mercedes-Benz',
  'Audi',
  'Toyota',
  'Lexus',
  'Honda',
  'Mazda',
  'Subaru',
  'Nissan',
  'Bentley',
  'Maserati',
  'Ferrari',
  'Lamborghini',
  'Aston Martin',
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getFilters() {
  const res = await fetch(`${API_BASE}/filters?api_key=${AUTOAPI_KEY}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('DIAGNOSTIC — Noms exacts modèles sur Encar');
  console.log('═══════════════════════════════════════════\n');

  let filters;
  try {
    filters = await getFilters();
  } catch (err) {
    console.error('❌ Erreur /filters:', err.message);
    process.exit(1);
  }

  const marks = filters.mark || filters;

  for (const marque of MARQUES_A_CHECKER) {
    // Cherche la marque (insensible à la casse)
    const key = Object.keys(marks).find(
      k => k.toLowerCase() === marque.toLowerCase()
    );

    if (!key) {
      console.log(`❌ ${marque} — NON TROUVÉE sur Encar`);
      continue;
    }

    const models = Object.keys(marks[key]?.model || {});
    console.log(`\n✅ ${key} — ${models.length} modèles :`);
    models.sort().forEach(m => console.log(`   • ${m}`));
  }

  console.log('\n═══════════════════════════════════════════');
  console.log('FIN DU DIAGNOSTIC');
  console.log('═══════════════════════════════════════════');
}

main().catch(err => {
  console.error('💥', err.message);
  process.exit(1);
});
