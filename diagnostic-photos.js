/**
 * DIAGNOSTIC PHOTOS — Structure exacte des annonces auto-api.com
 * Lance : node diagnostic-photos.js
 */
require('dotenv').config();
const fetch = require('node-fetch');

const AUTOAPI_KEY = process.env.AUTOAPI_KEY || 'MEBkasK6mKDfJkAQ9499';
const API_BASE = 'https://api1.auto-api.com/api/v2/encar';

async function main() {
  console.log('Récupération d\'une annonce BMW M3...');
  
  const res = await fetch(
    `${API_BASE}/offers?api_key=${AUTOAPI_KEY}&page=1&mark=BMW&model=M3`,
    { headers: { 'Content-Type': 'application/json' } }
  );
  
  const json = await res.json();
  const items = json.result || json.data || json.cars || [];
  
  if (!items.length) {
    console.log('Aucun résultat');
    console.log('Structure réponse:', JSON.stringify(json).substring(0, 500));
    return;
  }

  const first = items[0];
  const car = first.data || first;
  
  console.log('\n=== STRUCTURE D\'UNE ANNONCE ===');
  console.log('Clés disponibles:', Object.keys(car).join(', '));
  console.log('\n--- PHOTOS ---');
  console.log('car.images:', JSON.stringify(car.images));
  console.log('car.image:', car.image);
  console.log('car.photo:', car.photo);
  console.log('car.photos:', JSON.stringify(car.photos));
  console.log('car.thumbnail:', car.thumbnail);
  console.log('car.img:', car.img);
  
  console.log('\n--- ANNONCE COMPLÈTE (premiers 2000 chars) ---');
  console.log(JSON.stringify(car).substring(0, 2000));
}

main().catch(console.error);
