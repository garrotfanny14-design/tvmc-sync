require('dotenv').config();
const fetch = require('node-fetch');

const AUTOAPI_KEY = process.env.AUTOAPI_KEY || 'MEBkasK6mKDfJkAQ9499';
const API_BASE    = 'https://api1.auto-api.com/api/v2/encar';

async function main() {
  const res = await fetch(`${API_BASE}/filters?api_key=${AUTOAPI_KEY}`);
  const filters = await res.json();
  const marks = filters.mark || filters;

  // Afficher TOUTES les marques disponibles
  console.log('TOUTES LES MARQUES ENCAR VIA AUTO-API :');
  console.log('════════════════════════════════════════');
  Object.keys(marks).sort().forEach(m => {
    const count = Object.keys(marks[m]?.model || {}).length;
    console.log(`  • ${m} (${count} modèles)`);
  });

  // Chercher Maybach spécifiquement
  console.log('\nRECHERCHE MAYBACH :');
  const maybachKey = Object.keys(marks).find(k => 
    k.toLowerCase().includes('maybach') || k.includes('마이바흐')
  );
  if (maybachKey) {
    console.log(`✅ Trouvé : "${maybachKey}"`);
    console.log('Modèles :', Object.keys(marks[maybachKey]?.model || {}));
  } else {
    console.log('❌ Maybach non trouvé');
  }

  // Chercher Land Cruiser
  console.log('\nRECHERCHE LAND CRUISER :');
  const toyota = marks['Toyota'];
  if (toyota) {
    const models = Object.keys(toyota.model || {});
    const lc = models.filter(m => m.toLowerCase().includes('land') || m.toLowerCase().includes('prado') || m.toLowerCase().includes('cruiser'));
    console.log('Toyota models contenant land/prado/cruiser :', lc.length ? lc : '❌ Aucun');
    console.log('Tous les modèles Toyota :', models.join(', '));
  }

  // Chercher Aston Martin
  console.log('\nRECHERCHE ASTON MARTIN :');
  const astonKey = Object.keys(marks).find(k => k.toLowerCase().includes('aston'));
  console.log(astonKey ? `✅ Trouvé : "${astonKey}"` : '❌ Non trouvé');
}

main().catch(console.error);
