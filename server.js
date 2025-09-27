const express = require('express');
const { request } = require('undici');
const pLimit = require('p-limit').default;
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "6f4cb8367f544db99cd1e2ea86fb2627f";
const MAX_CONCURRENT_REQUESTS = 5;

const searchFromAirports = [
  'WAW', // Warszawa Chopin
  'KRK', // Kraków Balice
  'BUD', // Budapeszt
  'VIE', // Wiedeń
  'PRG', // Praga
  'BER', // Berlin
  'FRA', // Frankfurt
  'CDG', // Paryż Charles de Gaulle
  'BRU', // Bruksela
  'OSL', // Oslo
  'ARN', // Sztokholm Arlanda
  'CPH', // Kopenhaga
  'AMS', // Amsterdam Schiphol
  'MXP', // Mediolan Malpensa
  // Największe europejskie huby:
  //'IST', // Stambuł
  'LHR', // Londyn Heathrow
  'BCN', // Barcelona El Prat
  'MAD', // Madryt Barajas
  //'LGW', // Londyn Gatwick
  'FCO', // Rzym Fiumicino
  'DUB', // Dublin
  'ZRH', // Zurych
  //'ORY', // Paryż Orly
  'MAN', // Manchester
  //'PMI', // Palma de Mallorca
  //'SVO', // Moskwa Szeremietiewo
  //'MUC', // Monachium
  //'LIS', // Lizbona Humberto Delgado
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
{ iata: 'CAN', country: 'China', city: 'Guangzhou' },
{ iata: 'HKG', country: 'Hong Kong', city: 'Hong Kong' },
{ iata: 'KUL', country: 'Malaysia', city: 'Kuala Lumpur' },
{ iata: 'BOM', country: 'India', city: 'Mumbai' },
{ iata: 'PKX', country: 'China', city: 'Beijing' },
{ iata: 'JED', country: 'Saudi Arabia', city: 'Jeddah' },
{ iata: 'CKG', country: 'China', city: 'Chongqing' },
{ iata: 'HGH', country: 'China', city: 'Hangzhou' },
{ iata: 'SHA', country: 'China', city: 'Shanghai' },
{ iata: 'KMG', country: 'China', city: 'Kunming' },
{ iata: 'XIY', country: 'China', city: 'Xi an' },
{ iata: 'TPE', country: 'Taiwan', city: 'Taipei' },
{ iata: 'BLR', country: 'India', city: 'Bangalore' },
{ iata: 'CJU', country: 'South Korea', city: 'Jeju' },
{ iata: 'CGO', country: 'China', city: 'Zhengzhou' },
];

let azjaFlightsCache = {};
let lastAzjaRefresh = null;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const limit = pLimit(MAX_CONCURRENT_REQUESTS);

function generateCacheKey(from, to, monthOutbound, monthInbound) {
  return `${from}-${to}-${monthOutbound}-${monthInbound}`;
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

function generateOutboundInboundMonthPairs(startDate, endDate) {
  const months = [];
  let d = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  while (d <= endDate) {
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    d.setMonth(d.getMonth() + 1);
  }
  const pairs = [];
  for (let i = 0; i < months.length; i++) {
    pairs.push([months[i], months[i]]);
    if (i + 1 < months.length) {
      pairs.push([months[i], months[i + 1]]);
    }
  }
  return pairs;
}

async function refreshAzjaFlightsRoundtrip() {
  console.log(`[${new Date().toISOString()}] Start odświeżania roundtrip lotów do Azji.`);
  azjaFlightsCache = {};
  lastAzjaRefresh = new Date();
  const now = new Date();
  const endDate = new Date(now);
  endDate.setMonth(endDate.getMonth() + 6);
  const monthPairs = generateOutboundInboundMonthPairs(now, endDate);
  const tasks = [];
  for (const from of searchFromAirports) {
    for (const dest of azjaAirports) {
      for (const [monthOutbound, monthInbound] of monthPairs) {
        const key = generateCacheKey(from, dest.iata, monthOutbound, monthInbound);
        if (!azjaFlightsCache[key]) azjaFlightsCache[key] = [];
        tasks.push(limit(async () => {
          try {
            const flight = await fetchRoundtripData(from, dest.iata, monthOutbound, monthInbound);
            if (flight && flight.data) {
              const price = (flight.data.MinPrice !== undefined && flight.data.MinPrice !== null)
                ? flight.data.MinPrice
                : Infinity;

              const arr = azjaFlightsCache[key];
              if (arr.length < 5) {
                arr.push({ ...flight, price });
                arr.sort((a, b) => a.price - b.price);
              } else if (price < arr[arr.length - 1].price) {
                arr[arr.length - 1] = { ...flight, price };
                arr.sort((a, b) => a.price - b.price);
              }
            }
          } catch (e) {
            console.error(`Błąd pobierania lotów ${from} → ${dest.iata} ${monthOutbound} → ${monthInbound}: ${e.message}`);
          }
        }));
      }
    }
  }
  await Promise.all(tasks);
  lastAzjaRefresh = new Date();
  const totalEntries = Object.values(azjaFlightsCache).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`[${lastAzjaRefresh.toISOString()}] Odświeżenie roundtrip zakończone. Wpisów w cache: ${totalEntries}`);
}

app.get('/api/azja-flights', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600'); // cache na 1 godzinę
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










