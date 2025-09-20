const express = require('express');
const { request } = require('undici');
const pLimit = require('p-limit').default;
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "6f4cb8367f544db99cd1e2ea86fb2627f";
const MAX_CONCURRENT_REQUESTS = 5;

const searchFromAirports = ['POZ', 'KTW', 'WAW', 'KRK', 'GDA', 'BER', 'BUD', 'VIE', 'PRG'];
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

let azjaFlightsCache = {};
let lastAzjaRefresh = null;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const limit = pLimit(MAX_CONCURRENT_REQUESTS);

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
      const parsedData = JSON.parse(text);

      if (!parsedData || !parsedData.PriceGrids) {
        console.log(`Brak danych lotów dla ${from} -> ${to} w ${monthOutbound}`);
        return null;
      }
      return { from, to, monthOutbound, monthInbound, data: parsedData };
    } catch (e) {
      if (attempts >= 2) throw e;
      console.error(`Błąd pobierania (retry ${attempts}): ${url} - ${e.message}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// Generuje pary (M, M) i (M, M+1) na 12 miesięcy do przodu
function generateOutboundInboundMonthPairs(startDate) {
  const months = [];
  const endDate = new Date(startDate.getFullYear(), startDate.getMonth() + 12, 1);
  let d = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  while (d <= endDate) {
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    d.setMonth(d.getMonth() + 1);
  }

  const pairs = [];
  for (let i = 0; i < months.length; i++) {
    // Para (M, M) - wylot i powrót w tym samym miesiącu
    pairs.push({ monthOutbound: months[i], monthInbound: months[i] });

    // Para (M, M+1) - wylot w danym miesiącu, powrót w następnym
    if (i + 1 < months.length) {
      pairs.push({ monthOutbound: months[i], monthInbound: months[i + 1] });
    }
  }
  return pairs;
}

async function refreshAzjaFlightsRoundtrip() {
  console.log(`[${new Date().toISOString()}] Start odświeżania lotów do Azji.`);
  azjaFlightsCache = {};
  lastAzjaRefresh = new Date();
  const now = new Date();

  // Generujemy wszystkie potrzebne pary miesięcy
  const monthPairs = generateOutboundInboundMonthPairs(now);

  const tasks = [];
  for (const from of searchFromAirports) {
    for (const dest of azjaAirports) {
      for (const { monthOutbound, monthInbound } of monthPairs) {
        tasks.push(limit(async () => {
          try {
            const flightData = await fetchRoundtripData(from, dest.iata, monthOutbound, monthInbound);
            if (flightData) {
              // Zmieniamy klucz cache na KRAJ-MIESIĄC, żeby dane nie były nadpisywane
              const key = `${dest.country}-${monthOutbound}`;
              if (!azjaFlightsCache[key]) {
                azjaFlightsCache[key] = [];
              }
              azjaFlightsCache[key].push(flightData);
            }
          } catch (e) {
            console.error(`Błąd pobierania lotów ${from} → ${dest.iata} ${monthOutbound} → ${monthInbound}: ${e.message}`);
          }
        }));
      }
    }
  }

  await Promise.all(tasks);

  // Zoptymalizowany etap: posortowanie i ograniczenie liczby wyników
  for (const key in azjaFlightsCache) {
    azjaFlightsCache[key] = azjaFlightsCache[key]
      .map(flight => {
        const prices = Object.values(flight.data.PriceGrids.Grid).flatMap(row =>
          row.filter(cell => cell && cell.Indirect && cell.Indirect.Price).map(cell => cell.Indirect.Price)
        );
        const minPrice = prices.length > 0 ? Math.min(...prices) : Infinity;
        return { ...flight, minPrice };
      })
      .sort((a, b) => a.minPrice - b.minPrice)
      .slice(0, 5);
  }

  lastAzjaRefresh = new Date();
  console.log(`[${lastAzjaRefresh.toISOString()}] Odświeżenie lotów do Azji zakończone. Liczba grup: ${Object.keys(azjaFlightsCache).length}`);
}

app.get('/api/azja-flights', (req, res) => {
  res.json({ refreshed: lastAzjaRefresh, flightsByCountry: azjaFlightsCache });
});

app.post('/api/refresh-azja', async (req, res) => {
  try {
    await refreshAzjaFlightsRoundtrip();
    res.json({ status: 'success', refreshed: lastAzjaRefresh });
  } catch (error) {
    console.error(`Błąd w endpoint /api/refresh-azja: ${error.message}`);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Serwer działa na http://localhost:${PORT}`);
});

refreshAzjaFlightsRoundtrip();
