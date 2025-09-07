const express = require('express');
const { request } = require('undici');
const pLimit = require('p-limit').default;
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "6f4cb8367f544db99cd1e2ea86fb2627f";
const MAX_CONCURRENT_REQUESTS = 5;

const searchFromAirports = ['POZ'];
const azjaAirports = [{ iata: 'ICN', country: 'South Korea', city: 'Seoul' }];

let azjaFlightsCache = {}; // klucz: from-to, wartość: tablica lotów
let lastAzjaRefresh = null;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Limit równoległych zapytań
const limit = pLimit(MAX_CONCURRENT_REQUESTS);

function generateCacheKey(from, to) {
  return `${from}-${to}`;
}

async function fetchRoundtripData(from, to, monthOutbound, monthInbound) {
  const url = `https://www.skyscanner.se/g/monthviewservice/PL/PLN/pl-PL/calendar/${from}/${to}/${monthOutbound}/${monthInbound}/?profile=minimalmonthviewgridv2&apikey=${API_KEY}`;
  let attempts = 0;
  while (attempts < 2) {
    attempts++;
    try {
      const { body, statusCode } = await request(url);
      if (statusCode !== 200) {
        if (attempts >= 2) throw new Error(`Błąd API status ${statusCode} dla ${url}`);
        console.log(`Status ${statusCode}, retry ${attempts} dla ${url}`);
        continue;
      }
      const text = await body.text();
      return { from, to, monthOutbound, monthInbound, data: JSON.parse(text) };
    } catch (e) {
      if (attempts >= 2) throw e;
      console.error(`Błąd pobierania (retry ${attempts}): ${url} - ${e.message}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

async function refreshAzjaFlightsRoundtrip() {
  console.log(`[${new Date().toISOString()}] Start odświeżania roundtrip lotów POZ → ICN.`);

  azjaFlightsCache = {};
  lastAzjaRefresh = new Date();

  const now = new Date();
  const endDate = new Date(now);
  endDate.setMonth(endDate.getMonth() + 6);

  const months = [];
  let d = new Date(now.getFullYear(), now.getMonth(), 1);
  while (d <= endDate) {
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,'0')}`);
    d.setMonth(d.getMonth() + 1);
  }

  const key = generateCacheKey('POZ', 'ICN');
  azjaFlightsCache[key] = [];

  const tasks = [];
  for (let i = 0; i < months.length; i++) {
    for (let j = i; j < months.length; j++) {
      tasks.push(limit(async () => {
        try {
          const flight = await fetchRoundtripData('POZ', 'ICN', months[i], months[j]);
          if (flight && flight.data) {
            azjaFlightsCache[key].push(flight);
            console.log(`Pobrano roundtrip: POZ → ICN ${months[i]} → ${months[j]}`);
          }
        } catch (e) {
          console.error(`Błąd pobierania lotów POZ → ICN ${months[i]} → ${months[j]}: ${e.message}`);
        }
      }));
    }
  }

  await Promise.all(tasks);

  // Posortuj cache po cenie jeśli jest w danych MinPrice, lub else ustaw cenę na Infinity  
  azjaFlightsCache[key] = azjaFlightsCache[key]
    .filter(f => f.data) // filtrujemy null lub brak danych
    .map(f => ({
      ...f,
      price: (f.data.MinPrice !== undefined && f.data.MinPrice !== null) ? f.data.MinPrice : Infinity,
    }))
    .sort((a, b) => a.price - b.price)
    .slice(0, 20);

  lastAzjaRefresh = new Date();
  console.log(`[${lastAzjaRefresh.toISOString()}] Odświeżenie roundtrip zakończone. Wpisów w cache: ${azjaFlightsCache[key].length}`);
}

app.get('/api/azja-flights', (req, res) => {
  res.json({ refreshed: lastAzjaRefresh, flightsByRoute: azjaFlightsCache });
});

refreshAzjaFlightsRoundtrip();
setInterval(refreshAzjaFlightsRoundtrip, 15 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Serwer działa na http://localhost:${PORT}`);
});
