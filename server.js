const express = require('express');
const { request } = require('undici');
const pLimit = require('p-limit').default;
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "6f4cb8367f544db99cd1e2ea86fb2627f";
const MAX_CONCURRENT_REQUESTS = 5; // zmniejszone do 5

const searchFromAirports = [
  'WAW', 'KRK', 'KTW', 'POZ', 'GDN',
  'BER',
  'PRG',
];
const azjaAirports = [
  { iata: 'BKK', country: 'Thailand', city: 'Bangkok' },
  { iata: 'HKT', country: 'Thailand', city: 'Phuket' },
  { iata: 'PEK', country: 'China', city: 'Beijing' },
  { iata: 'PVG', country: 'China', city: 'Shanghai' },
  { iata: 'HND', country: 'Japan', city: 'Tokyo' },
  { iata: 'NRT', country: 'Japan', city: 'Tokyo' },
  { iata: 'ICN', country: 'South Korea', city: 'Seoul' },
  { iata: 'SGN', country: 'Vietnam', city: 'Ho Chi Minh City' },
  { iata: 'HAN', country: 'Vietnam', city: 'Hanoi' },
  { iata: 'NQZ', country: 'Kazakhstan', city: 'Astana' },
  { iata: 'ALA', country: 'Kazakhstan', city: 'Almaty' },
  { iata: 'FRU', country: 'Kyrgyzstan', city: 'Bishkek' },
  { iata: 'MNL', country: 'Philippines', city: 'Manila' },
  { iata: 'CGK', country: 'Indonesia', city: 'Jakarta' },
  { iata: 'DPS', country: 'Indonesia', city: 'Bali Denpasar' },
  { iata: 'CMB', country: 'Sri Lanka', city: 'Colombo' },
  { iata: 'DEL', country: 'India', city: 'Delhi' },
  { iata: 'MCT', country: 'Oman', city: 'Muscat' },
  { iata: 'DOH', country: 'Qatar', city: 'Doha' },
  { iata: 'DXB', country: 'United Arab Emirates', city: 'Dubai' },
  { iata: 'AUH', country: 'United Arab Emirates', city: 'Abu Dhabi' },
  { iata: 'SIN', country: 'Singapore', city: 'Singapore' },
  { iata: 'TBS', country: 'Georgia', city: 'Tbilisi' },
  { iata: 'KUT', country: 'Georgia', city: 'Kutaisi' },
  { iata: 'GYD', country: 'Azerbaijan', city: 'Baku' },
  { iata: 'IST', country: 'Turkey', city: 'Istanbul' },
  { iata: 'SAW', country: 'Turkey', city: 'Istanbul Sabiha' },
];

let azjaFlightsCache = {}; // klucz: from-to, wartość: tablica max 10 najtańszych lotów
let lastAzjaRefresh = null;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Limit równoległych zapytań
const limit = pLimit(MAX_CONCURRENT_REQUESTS);

function generateCacheKey(from, to) {
  return `${from}-${to}`;
}

function insertOrReplaceCheapest(cacheArray, newFlight) {
  // Załóżmy, że cena minimalna jest dostępna w newFlight.data.MinPrice
  if (!newFlight.data || !newFlight.data.MinPrice) return;

  const price = newFlight.data.MinPrice;

  // Sprawdź czy już jest w cacheArray lot dla tej samej pary miesiąców
  const existingIndex = cacheArray.findIndex(f =>
    f.monthOutbound === newFlight.monthOutbound &&
    f.monthInbound === newFlight.monthInbound
  );

  if (existingIndex >= 0) {
    // Jeśli nowy lot tańszy, zastąp
    if ((cacheArray[existingIndex].data.MinPrice || Infinity) > price) {
      cacheArray[existingIndex] = newFlight;
    }
  } else {
    // Dodaj jeśli jest mniej niż 10 lotów
    if (cacheArray.length < 10) {
      cacheArray.push(newFlight);
    } else {
      // Jeśli jest 10 lotów, zastąp najdroższy jeśli ten nowy jest tańszy
      let maxPrice = -Infinity;
      let maxIndex = -1;
      cacheArray.forEach((f, idx) => {
        const p = f.data.MinPrice || -Infinity;
        if (p > maxPrice) {
          maxPrice = p;
          maxIndex = idx;
        }
      });
      if (price < maxPrice && maxIndex >=0) {
        cacheArray[maxIndex] = newFlight;
      }
    }
  }
}

async function fetchRoundtripData(from, to, monthOutbound, monthInbound) {
  const url = `https://www.skyscanner.se/g/monthviewservice/PL/PLN/pl-PL/calendar/${from}/${to}/${monthOutbound}/${monthInbound}/?profile=minimalmonthviewgridv2&apikey=${API_KEY}`;
  let attempts = 0;
  while(attempts < 2){
    attempts++;
    try {
      const { body, statusCode } = await request(url);
      if(statusCode !== 200){
        if(attempts >= 2) throw new Error(`Błąd API status ${statusCode} dla ${url}`);
        console.log(`Status ${statusCode}, retry ${attempts} dla ${url}`);
        continue;
      }
      const text = await body.text();
      return { from, to, monthOutbound, monthInbound, data: JSON.parse(text) }
    } catch(e){
      if(attempts >= 2) throw e;
      console.error(`Błąd pobierania (retry ${attempts}): ${url} - ${e.message}`);
      await new Promise(r=>setTimeout(r, 1000));
    }
  }
}

async function refreshAzjaFlightsRoundtrip() {
  console.log(`[${new Date().toISOString()}] Start odświeżania roundtrip lotów do Azji.`);
  azjaFlightsCache = {};
  lastAzjaRefresh = new Date();

  const now = new Date();
  const endDate = new Date(now);
  endDate.setMonth(endDate.getMonth() + 6);

  const months = [];
  let d = new Date(now.getFullYear(), now.getMonth(), 1);
  while(d <= endDate){
    months.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
    d.setMonth(d.getMonth() +1);
  }

  const tasks = [];

  for(const from of searchFromAirports){
    for(const dest of azjaAirports){
      const key = generateCacheKey(from, dest.iata);
      if(!azjaFlightsCache[key]) azjaFlightsCache[key] = [];

      for(let i=0; i<months.length; i++){
        for(let j=i; j<months.length; j++){
          tasks.push(limit(async () => {
            try{
              const flight = await fetchRoundtripData(from, dest.iata, months[i], months[j]);
              if(flight && flight.data){
                insertOrReplaceCheapest(azjaFlightsCache[key], flight);
                console.log(`Pobrano roundtrip: ${from} → ${dest.iata} ${months[i]} → ${months[j]}`);
              }
            }catch(e){
              console.error(`Błąd pobierania lotów ${from} → ${dest.iata} ${months[i]} → ${months[j]}: ${e.message}`);
            }
          }));
        }
      }
    }
  }

  await Promise.all(tasks);

  // Możesz posortować i ograniczyć do 10 najtańszych, ale insertOrReplaceCheapest to robi na bieżąco
  lastAzjaRefresh = new Date();
  console.log(`[${new Date().toISOString()}] Odświeżenie roundtrip zakończone. Wpisów w cache: ${Object.values(azjaFlightsCache).reduce((sum, arr) => sum + arr.length, 0)}`);
}

app.get('/api/azja-flights', (req,res) => {
  res.json({ refreshed: lastAzjaRefresh, flightsByCountry: azjaFlightsCache });
});

refreshAzjaFlightsRoundtrip();
setInterval(refreshAzjaFlightsRoundtrip, 15*60*1000);

app.listen(PORT, () => {
  console.log(`Serwer działa na http://localhost:${PORT}`);
});
