const express = require('express');
const { request } = require('undici');
const pLimit = require('p-limit').default;
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "6f4cb8367f544db99cd1e2ea86fb2627f";
const MAX_CONCURRENT_REQUESTS = 5;

// Skrócona lista lotnisk do testów
const searchFromAirports = ['POZ'];
const azjaAirports = [
  { iata: 'KUT', country: 'Georgia', city: 'Kutaisi' },
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
    pairs.push({ monthOutbound: months[i], monthInbound: months[i] });
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

  const monthPairs = generateOutboundInboundMonthPairs(now);

  const tasks = [];
  for (const from of searchFromAirports) {
    for (const dest of azjaAirports) {
      for (const { monthOutbound, monthInbound } of monthPairs) {
        tasks.push(limit(async () => {
          try {
            const flightData = await fetchRoundtripData(from, dest.iata, monthOutbound, monthInbound);
            if (flightData) {
              const key = `${dest.country}-${monthOutbound}`;
              if (!azjaFlightsCache[key]) {
                azjaFlightsCache[key] = [];
              }
              const validFlights = Object.values(flightData.data.PriceGrids.Grid)
                .flatMap(row => row)
                .filter(cell => cell && cell.Indirect && cell.Indirect.Price && cell.Indirect.Duration)
                .filter(cell => cell.Indirect.Duration >= 4 && cell.Indirect.Duration <= 21)
                .map(cell => ({
                  from: flightData.from,
                  to: flightData.to,
                  price: cell.Indirect.Price,
                  outboundDate: `${flightData.monthOutbound}-${String(cell.OutboundDate).padStart(2, '0')}`,
                  inboundDate: `${flightData.monthInbound}-${String(cell.InboundDate).padStart(2, '0')}`,
                  duration: cell.Indirect.Duration,
                  url: `https://www.skyscanner.pl/transport/loty/${flightData.from}/${flightData.to}/${flightData.monthOutbound}-${String(cell.OutboundDate).padStart(2, '0')}/${flightData.monthInbound}-${String(cell.InboundDate).padStart(2, '0')}/`,
                }));
              azjaFlightsCache[key].push(...validFlights);
            }
          } catch (e) {
            console.error(`Błąd pobierania lotów ${from} → ${dest.iata} ${monthOutbound} → ${monthInbound}: ${e.message}`);
          }
        }));
      }
    }
  }

  await Promise.all(tasks);

  for (const key in azjaFlightsCache) {
    azjaFlightsCache[key] = azjaFlightsCache[key]
      .sort((a, b) => a.price - b.price)
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
