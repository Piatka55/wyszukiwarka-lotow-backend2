const express = require('express');
const { request } = require('undici');
const pLimit = require('p-limit').default;
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "6f4cb8367f544db99cd1e2ea86fb2627f";
const MAX_CONCURRENT_REQUESTS = 10;

// Lotniska startowe
const searchFromAirports = [
  'WAW', 'KRK', 'KTW', 'POZ', 'GDN',        // Polska
  'FRA', 'MUC', 'TXL', 'DUS', 'HAM',        // Niemcy
  'PRG',                                    // Praga
  'LHR', 'LGW', 'STN',                      // Londyn
  'MAN',                                    // Manchester
  'VIE',                                    // Wiedeń
  'BUD',                                    // Budapeszt
  'BTS'                                     // Bratysława
];

// Lotniska docelowe - Azja i pobliskie
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
  { iata: 'SAW', country: 'Turkey', city: 'Istanbul Sabiha' }
];

let azjaFlightsCache = [];
let lastAzjaRefresh = null;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Limit równoczesnych zapytań
const limit = pLimit(MAX_CONCURRENT_REQUESTS);

async function fetchRoundtripData(from, to, monthOutbound, monthInbound) {
  const url = `https://www.skyscanner.se/g/monthviewservice/PL/PLN/pl-PL/calendar/${from}/${to}/${monthOutbound}/${monthInbound}/?profile=minimalmonthviewgridv2&apikey=${API_KEY}`;
  try {
    const { body, statusCode } = await request(url);
    if (statusCode !== 200) {
      console.error(`Błąd API (roundtrip): status ${statusCode} dla ${url}`);
      return null;
    }
    const text = await body.text();
    return { from, to, monthOutbound, monthInbound, data: JSON.parse(text) };
  } catch (e) {
    console.error(`Błąd pobierania (roundtrip) ${url}:`, e.message);
    return null;
  }
}

async function refreshAzjaFlightsRoundtrip() {
  console.log(`[${new Date().toISOString()}] Start odświeżania roundtrip lotów do Azji.`);
  azjaFlightsCache = [];
  lastAzjaRefresh = new Date();

  const now = new Date();
  const endDate = new Date(now);
  endDate.setFullYear(now.getFullYear() + 1);

  // Lista miesięcy za rok do przodu
  const months = [];
  let d = new Date(now.getFullYear(), now.getMonth(), 1);
  while (d <= endDate) {
    months.push(`${d.getFullYear()}-${String(d.getMonth() +1).padStart(2,'0')}`);
    d.setMonth(d.getMonth() +1);
  }

  const tasks = [];

  for (const from of searchFromAirports) {
    for (const dest of azjaAirports) {
      for (let i = 0; i < months.length; i++) {
        for (let j = i; j < months.length; j++) {  // return month >= outbound month
          tasks.push(limit(async () => {
            const result = await fetchRoundtripData(from, dest.iata, months[i], months[j]);
            if (result) {
              azjaFlightsCache.push(result);
              console.log(`Pobrano roundtrip: ${from} → ${dest.iata} ${months[i]} → ${months[j]}`);
            }
          }));
        }
      }
    }
  }

  await Promise.all(tasks);

  console.log(`[${new Date().toISOString()}] Odświeżenie roundtrip zakończone. Wpisów w cache: ${azjaFlightsCache.length}`);
}

app.get('/api/azja-flights', (req, res) => {
  res.json({ refreshed: lastAzjaRefresh, flights: azjaFlightsCache });
});

refreshAzjaFlightsRoundtrip();
setInterval(refreshAzjaFlightsRoundtrip, 15 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Serwer działa na http://localhost:${PORT}`);
});
