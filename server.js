const express = require('express');
const { request } = require('undici');
const pLimit = require('p-limit').default;
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "6f4cb8367f544db99cd1e2ea86fb2627f";
const MAX_CONCURRENT_REQUESTS = 50;

// Lotniska startowe i docelowe (prosty przykład z jedną trasą, rozbuduj wg potrzeby)
const searchFromAirports = ['WAW'];
const azjaAirports = [
  { iata: 'BKK', country: 'Thailand', city: 'Bangkok' }
];

let azjaFlightsCache = [];
let lastAzjaRefresh = null;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Superszybki limit równoczesnych fetchy
const limit = pLimit(10);

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
  console.log(`[${new Date().toISOString()}] Rozpoczynam odświeżanie roundtrip lotów do Azji.`);
  azjaFlightsCache = [];
  lastAzjaRefresh = new Date();

  const now = new Date();
  const endDate = new Date(now);
  endDate.setFullYear(now.getFullYear() + 1);

  // Generujemy listę miesięcy między teraz a rokiem do przodu
  const months = [];
  let d = new Date(now.getFullYear(), now.getMonth(), 1);
  while (d <= endDate) {
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    d.setMonth(d.getMonth() + 1);
  }

  const tasks = [];

  for (const from of searchFromAirports) {
    for (const dest of azjaAirports) {
      for (let i = 0; i < months.length; i++) {
        for (let j = i; j < months.length; j++) {   // return month is equal or after outbound month
          const monthOutbound = months[i];
          const monthInbound = months[j];
          tasks.push(limit(async () => {
            const flightData = await fetchRoundtripData(from, dest.iata, monthOutbound, monthInbound);
            if (flightData) {
              azjaFlightsCache.push(flightData);
              console.log(`Pobrano roundtrip ${from} → ${dest.iata} / ${monthOutbound} → ${monthInbound}`);
            }
          }));
        }
      }
    }
  }

  await Promise.all(tasks);

  console.log(`[${new Date().toISOString()}] Odświeżanie roundtrip lotów zakończone. Wpisów: ${azjaFlightsCache.length}`);
}

// Endpoint zwraca cache lotów roundtrip i czas ostatniego odświeżenia
app.get('/api/azja-flights', (req, res) => {
  res.json({ refreshed: lastAzjaRefresh, flights: azjaFlightsCache });
});

refreshAzjaFlightsRoundtrip();
setInterval(refreshAzjaFlightsRoundtrip, 15 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Serwer działa na http://localhost:${PORT}`);
});
