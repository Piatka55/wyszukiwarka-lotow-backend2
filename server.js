const express = require('express');
const { request } = require('undici');
const pLimit = require('p-limit').default;
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "6f4cb8367f544db99cd1e2ea86fb2627f";

const searchFromAirports = ['WAW']; // tylko Warszawa
const azjaAirports = [
  { iata: 'BKK', country: 'Thailand', city: 'Bangkok' }
];

let azjaFlightsCache = [];
let lastAzjaRefresh = null;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// limit równoczesnych zapytań
const limit = pLimit(5);

async function refreshAzjaFlights() {
  console.log(`[${new Date().toISOString()}] Rozpoczynam odświeżanie lotów do Azji (WAW → BKK).`);
  azjaFlightsCache = [];
  lastAzjaRefresh = new Date();

  const now = new Date();
  const endDate = new Date(now);
  endDate.setFullYear(now.getFullYear() + 1);

  const months = [];
  let d = new Date(now.getFullYear(), now.getMonth(), 1);
  while (d <= endDate) {
    months.push(`${d.getFullYear()}-${String(d.getMonth() +1).padStart(2,'0')}`);
    d.setMonth(d.getMonth() +1);
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
            } else {
              console.error(`Błąd statusu ${statusCode} dla URL: ${url}`);
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

app.get('/api/azja-flights', (req, res) => {
  res.json({ refreshed: lastAzjaRefresh, flights: azjaFlightsCache });
});

refreshAzjaFlights();
setInterval(refreshAzjaFlights, 15 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Serwer działa na http://localhost:${PORT}`);
});
