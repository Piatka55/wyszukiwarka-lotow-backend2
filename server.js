const express = require('express');
const { request } = require('undici');
const pLimit = require('p-limit');
const cors = require('cors');

const app = express();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "6f4cb8367f544db99cd1e2ea86fb2627f";
const MAX_CONCURRENT_REQUESTS = 50;

// --- Lotniska startowe (Polska, Niemcy, Praga, Londyn, Manchester, Wiedeń, Budapeszt, Bratysława)
const searchFromAirports = [
  'WAW', 'KRK', 'KTW', 'POZ', 'GDN',      // Polska
  'FRA', 'MUC', 'TXL', 'DUS', 'HAM',      // Niemcy
  'PRG',                                  // Praga
  'LHR', 'LGW', 'STN',                    // Londyn
  'MAN',                                  // Manchester
  'VIE',                                  // Wiedeń
  'BUD',                                  // Budapeszt
  'BTS'                                   // Bratysława
];

// --- Lotniska docelowe w Azji (w tym Kirgistan, Katar, Singapur)
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

// --- Funkcja do pobierania lotów i odświeżania cache ---
const limit = pLimit(10);

async function refreshAzjaFlights() {
  console.log(`[${new Date().toISOString()}] Rozpoczynam odświeżanie lotów do Azji.`);
  azjaFlightsCache = [];
  lastAzjaRefresh = new Date();

  // Oblicz datę roku do przodu od dzisiaj (np. 23.08.2025 → 23.08.2026)
  const now = new Date();
  const endDate = new Date(now);
  endDate.setFullYear(now.getFullYear() + 1);

  // Zbierz kolejne miesiące z zakresu teraz → rok do przodu (włączając miesiąc końcowy)
  const months = [];
  let d = new Date(now.getFullYear(), now.getMonth(), 1);
  while (d <= endDate) {
    months.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
    d.setMonth(d.getMonth() + 1);
  }

  const tasks = [];

  for (const from of searchFromAirports) {
    for (const dest of azjaAirports) {
      for (const month of months) {
        const url = `https://www.skyscanner.pl/g/monthviewservice/PL/PLN/pl-PL/calendar/${from}/${dest.iata}/${month}/?profile=minimalmonthviewgridv2&apikey=${API_KEY}`;
        tasks.push(limit(async () => {
          try {
            const { body, statusCode } = await request(url);
            const text = await body.text();
            if (statusCode === 200) {
              azjaFlightsCache.push({
                from,
                to: dest.iata,
                country: dest.country,
                city: dest.city,
                month,
                data: JSON.parse(text)
              });
              console.log(`Pobrano loty ${from} → ${dest.iata} na ${month}`);
            }
          } catch (e) {
            console.error(`Błąd pobierania ${url}:`, e.message);
          }
        }));
      }
    }
  }

  await Promise.all(tasks);

  console.log(`[${new Date().toISOString()}] Odświeżanie lotów zakończone. Ilość wpisów: ${azjaFlightsCache.length}`);
}

// Endpoint zwraca max 10 najtańszych lotów na kraj oraz czas ostatniego odświeżenia
app.get('/api/azja-flights', (req, res) => {
  const grouped = {};
  azjaFlightsCache.forEach(flight => {
    if (!grouped[flight.country]) grouped[flight.country] = [];
    grouped[flight.country].push(flight);
  });

  const result = {};
  for (const country in grouped) {
    result[country] = grouped[country]
      .sort((a, b) => {
        const aPrice = a.data.MinPrice || Infinity;
        const bPrice = b.data.MinPrice || Infinity;
        return aPrice - bPrice;
      })
      .slice(0, 10);
  }

  res.json({ refreshed: lastAzjaRefresh, flightsByCountry: result });
});

// Uruchom pierwsze odświeżenie i zaplanuj co 15 min
refreshAzjaFlights();
setInterval(refreshAzjaFlights, 15 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Serwer działa na http://localhost:${PORT}`);
});