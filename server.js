const express = require('express');
const { request } = require('undici');
const pLimit = require('p-limit').default;
const cors = require('cors');
const app = express();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "6f4cb8367f544db99cd1e2ea86fb2627f";
const MAX_CONCURRENT_REQUESTS = 5;

const searchFromAirports = ['POZ'];
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
  { iata: 'SAW', country: 'Turkey', city: 'Istanbul Sabiha' }
];

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const limit = pLimit(MAX_CONCURRENT_REQUESTS);

function generateCacheKey(from, to) {
  return `${from}-${to}`;
}

function formatDate(d) {
  return d.toISOString().split('T')[0];
}

function generateSkyscannerLink(from, to, departureDate, returnDate) {
  // Przykład linku do Skyscannera (PL wersja)
  return `https://www.skyscanner.pl/transport/kiedy-${from}-${to}/loty-wylot-${departureDate}/loty-powrot-${returnDate}/`;
}

async function fetchRoundtripData(from, to, monthOutbound, monthInbound) {
  const url = `https://www.skyscanner.se/g/monthviewservice/PL/PLN/pl-PL/calendar/${from}/${to}/${monthOutbound}/${monthInbound}/?profile=minimalmonthviewgridv2&apikey=${API_KEY}`;
  try {
    const { body, statusCode } = await request(url);
    if (statusCode !== 200) {
      throw new Error(`Błąd API status ${statusCode} dla ${url}`);
    }
    const text = await body.text();
    return { from, to, monthOutbound, monthInbound, data: JSON.parse(text) };
  } catch (e) {
    console.error(`Błąd pobierania: ${url} - ${e.message}`);
    return null;
  }
}

function extractCheapestTripsWithRange(data, minNights = 6, maxNights = 14) {
  if (!data || !data.PriceGrids || !Array.isArray(data.PriceGrids.Grid)) return [];

  const grid = data.PriceGrids.Grid;
  const outboundDates = data.OutboundFlightDates || [];
  const inboundDates = data.InboundFlightDates || [];
  const trips = [];

  for (let i = 0; i < grid.length; i++) {
    for (let j = 0; j < grid[i].length; j++) {
      const cell = grid[i][j];
      if (!cell || typeof cell.MinPrice !== 'number') continue;

      // Oblicz długość pobytu w dniach
      if (i >= outboundDates.length || j >= inboundDates.length) continue;
      const outDate = new Date(outboundDates[i]);
      const inDate = new Date(inboundDates[j]);
      const diffDays = (inDate - outDate) / (1000 * 60 * 60 * 24);

      if (diffDays >= minNights && diffDays <= maxNights && diffDays > 0) {
        trips.push({
          departureDate: outboundDates[i],
          returnDate: inboundDates[j],
          price: cell.MinPrice,
          directOutboundAvailable: cell.DirectOutboundAvailable,
          directInboundAvailable: cell.DirectInboundAvailable
        });
      }
    }
  }

  return trips;
}

async function refreshAzjaFlightsRoundtrip() {
  console.log(`[${new Date().toISOString()}] Start odświeżania lotów z zakresem 6-14 dni.`);

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

  const tasks = [];

  for (const from of searchFromAirports) {
    for (const dest of azjaAirports) {
      const key = generateCacheKey(from, dest.iata);
      if (!azjaFlightsCache[key]) azjaFlightsCache[key] = [];

      for (let i = 0; i < months.length; i++) {
        for (let j = i; j < months.length; j++) {
          tasks.push(limit(async () => {
            const flight = await fetchRoundtripData(from, dest.iata, months[i], months[j]);
            if (flight && flight.data) {
              const trips = extractCheapestTripsWithRange(flight.data, 6, 14);

              trips.forEach(trip => {
                azjaFlightsCache[key].push({
                  from,
                  to: dest.iata,
                  cityFrom: from, // Możesz mapować na miasto jeśli masz bazę
                  cityTo: dest.city,
                  departureDate: trip.departureDate,
                  returnDate: trip.returnDate,
                  price: trip.price,
                  directOutboundAvailable: trip.directOutboundAvailable,
                  directInboundAvailable: trip.directInboundAvailable,
                  skyscannerUrl: generateSkyscannerLink(
                    from,
                    dest.iata,
                    trip.departureDate,
                    trip.returnDate
                  )
                });
              });

              console.log(`Pobrano loty: ${from} → ${dest.iata} na miesiące ${months[i]} → ${months[j]}`);
            }
          }));
        }
      }
    }
  }

  await Promise.all(tasks);

  // Sortujemy i ograniczamy do 10 najtańszych na parę tras
  Object.keys(azjaFlightsCache).forEach(key => {
    azjaFlightsCache[key] = azjaFlightsCache[key]
      .sort((a, b) => a.price - b.price)
      .slice(0, 10);
  });

  console.log(`[${new Date().toISOString()}] Odświeżanie zakończone - wpisów w cache: ${Object.values(azjaFlightsCache).reduce((sum, arr) => sum + arr.length, 0)}`);
}

let azjaFlightsCache = {};
let lastAzjaRefresh = null;

app.get('/api/azja-flights', (req, res) => {
  res.json({ refreshed: lastAzjaRefresh, flightsByRoute: azjaFlightsCache });
});

refreshAzjaFlightsRoundtrip();
setInterval(refreshAzjaFlightsRoundtrip, 15 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Serwer działa na http://localhost:${PORT}`);
});


