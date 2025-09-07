const express = require('express');
const { request } = require('undici');
const pLimit = require('p-limit').default;
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "6f4cb8367f544db99cd1e2ea86fb2627";
const MAX_CONCURRENT_REQUESTS = 15; // pod cache i batch
const limit = pLimit(MAX_CONCURRENT_REQUESTS);

// --- CACHING: tylko POZ → ICN i roundtrip ---
let flightsCache = [];
let lastCacheRefresh = null;

// Pętla miesięcy
function getMonthsAhead(n) {
  const months = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return months;
}

// Pobieranie roundtrip z cache
async function fetchRoundtrip(from, to, outMonth, inMonth) {
  const url = `https://www.skyscanner.se/g/monthviewservice/PL/PLN/pl-PL/calendar/${from}/${to}/${outMonth}/${inMonth}/?profile=minimalmonthviewgridv2&apikey=${API_KEY}`;
  try {
    const { body, statusCode } = await request(url);
    const text = await body.text();
    if (statusCode !== 200) throw new Error(`API error: ${statusCode} ${url}`);
    const parsed = JSON.parse(text);
    // MinPrice może być: parsed.MinPrice, parsed.quotes, parsed.Days, etc.
    // Najczęściej w minimalmonthviewgridv2 używamy parsed.Days[dzien].MinPrice
    let bestDay = null;
    let bestPrice = Infinity;
    if (parsed.Days) {
      for (const day of Object.values(parsed.Days)) {
        if (day.MinPrice && day.MinPrice < bestPrice) {
          bestDay = day;
          bestPrice = day.MinPrice;
        }
      }
    }
    if (bestDay) {
      return {
        from, to, outMonth, inMonth,
        minPrice: bestDay.MinPrice,
        bestDay: bestDay.Date,
      };
    }
    return null;
  } catch (e) {
    console.error(`Błąd pobierania roundtrip: ${e.message}`);
    return null;
  }
}

// Odświeżacz cache
async function refreshCache() {
  const from = 'POZ';
  const to = 'ICN';
  const months = getMonthsAhead(6);
  const flights = [];
  const tasks = [];
  for (let i = 0; i < months.length; i++) {
    for (let j = i; j < months.length; j++) {
      tasks.push(limit(() => fetchRoundtrip(from, to, months[i], months[j])));
    }
  }
  const results = await Promise.all(tasks);
  results.forEach(x => {
    if (x && x.minPrice) flights.push(x);
  });
  // Sortuj po cenie + limituj do 10 najtańszych
  flightsCache = flights.sort((a, b) => a.minPrice - b.minPrice).slice(0, 10);
  lastCacheRefresh = new Date();
  console.log(`[${lastCacheRefresh.toISOString()}] Flights cache updated: ${flightsCache.length} entries`);
}

// Endpoint do cache
app.get('/api/cached-flights', (req, res) => {
  res.json({
    refreshed: lastCacheRefresh,
    flights: flightsCache
  });
});

// Automatyczne odświeżanie co 15 minut
refreshCache();
setInterval(refreshCache, 15 * 60 * 1000);

// --- Reszta Twoich endpointów z batch i on-demand ---
app.use(express.json());
app.use(cors());
app.use(express.static('.'));

// --- POJEDYNCZY ONEWAY ---
app.get('/api/oneway', async (req, res) => {
  const { from, to, month, currency, locale } = req.query;
  if (!from || !to || !month || !currency || !locale) {
    return res.status(400).json({ error: 'Brakujące parametry dla lotu w jedną stronę.' });
  }
  const skyscannerUrl = `https://www.skyscanner.pl/g/monthviewservice/PL/${currency}/${locale}/calendar/${from}/${to}/${month}/?profile=minimalmonthviewgridv2&apikey=${API_KEY}`;
  try {
    const { body, statusCode } = await request(skyscannerUrl);
    const text = await body.text();
    if (statusCode !== 200) throw new Error(`Błąd API: ${statusCode}`);
    res.json(JSON.parse(text));
  } catch (error) {
    res.status(500).json({ error: 'Nie udało się pobrać danych z API Skyscannera.' });
  }
});

// --- POJEDYNCZY ROUNDTRIP ---
app.get('/api/flights', async (req, res) => {
  const { from, to, month, returnMonth, currency, locale } = req.query;
  if (!from || !to || !month || !returnMonth || !currency || !locale) {
    return res.status(400).json({ error: 'Brakujące parametry dla lotu w obie strony.' });
  }
  const skyscannerUrl = `https://www.skyscanner.se/g/monthviewservice/PL/${currency}/${locale}/calendar/${from}/${to}/${month}/${returnMonth}/?profile=minimalmonthviewgridv2&apikey=${API_KEY}`;
  try {
    const { body, statusCode } = await request(skyscannerUrl);
    const text = await body.text();
    if (statusCode !== 200) throw new Error(`Błąd API: ${statusCode}`);
    res.json(JSON.parse(text));
  } catch (error) {
    res.status(500).json({ error: 'Nie udało się pobrać danych z API Skyscannera.' });
  }
});

// --- BATCH ONEWAY ---
async function fetchUrl(url) {
  try {
    const { body, statusCode } = await request(url);
    const text = await body.text();
    return statusCode === 200
      ? JSON.parse(text)
      : { error: `HTTP ${statusCode}`, body: text };
  } catch {
    return { error: "Undici fetch error" };
  }
}
app.post('/api/batch-oneway', async (req, res) => {
  const { queries, currency = "PLN", locale = "pl-PL" } = req.body;
  if (!Array.isArray(queries) || queries.length === 0) {
    return res.status(400).json({ error: "Brak poprawnych danych wejściowych (queries[])." });
  }
  const limit = pLimit(MAX_CONCURRENT_REQUESTS);
  const urls = queries.map(({ from, to, month }) =>
    `https://www.skyscanner.pl/g/monthviewservice/PL/${currency}/${locale}/calendar/${from}/${to}/${month}/?profile=minimalmonthviewgridv2&apikey=${API_KEY}`
  );
  try {
    const tasks = urls.map((url, i) => limit(() => fetchUrl(url)));
    const results = await Promise.all(tasks);
    res.json(
      results.map((result, i) => ({
        query: queries[i],
        result
      }))
    );
  } catch (e) {
    res.status(500).json({ error: "Błąd batchowania zapytań do Skyscannera." });
  }
});

// uruchom serwer
app.listen(PORT, () => {
  console.log(`Serwer uruchomiony na http://localhost:${PORT}`);
});

