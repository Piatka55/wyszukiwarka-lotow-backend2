const express = require('express');
const { request } = require('undici');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "6f4cb8367f544db99cd1e2ea86fb2627f";
const MAX_CONCURRENT_REQUESTS = 5;

const searchFromAirports = [
  'POZ', // tylko Poznań
];

const destinationAirport = { iata: 'ICN', country: 'South Korea', city: 'Seoul' };
let flightsCache = []; // Tablica najtańszych lotów
let lastRefresh = null;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

function sortAndKeepCheapest(array, maxCount = 10) {
  // Sortuje po cenie rosnąco i limituje do maxCount
  return array
    .filter(f => f.data && f.data.MinPrice)
    .sort((a, b) => a.data.MinPrice - b.data.MinPrice)
    .slice(0, maxCount);
}

async function fetchRoundtripData(from, to, monthOutbound, monthInbound) {
  const url = `https://www.skyscanner.se/g/monthviewservice/PL/PLN/pl-PL/calendar/${from}/${to}/${monthOutbound}/${monthInbound}/?profile=minimalmonthviewgridv2&apikey=${API_KEY}`;
  try {
    const { body, statusCode } = await request(url);
    if (statusCode !== 200) throw new Error(`API error: ${statusCode} for ${url}`);
    const text = await body.text();
    return { from, to, monthOutbound, monthInbound, data: JSON.parse(text) };
  } catch(e) {
    console.error(`Fetch error: ${url} - ${e.message}`);
    return null;
  }
}

async function refreshFlights() {
  console.log(`[${new Date().toISOString()}] Start refresh POZ → ICN.`);
  flightsCache = [];
  lastRefresh = new Date();
  const now = new Date();
  const endDate = new Date(now);
  endDate.setMonth(endDate.getMonth() + 6);
  const months = [];
  let d = new Date(now.getFullYear(), now.getMonth(), 1);
  while(d <= endDate) {
    months.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
    d.setMonth(d.getMonth() + 1);
  }
  const tasks = [];
  for(let i=0; i<months.length; i++) {
    for(let j=i; j<months.length; j++) {
      tasks.push(
        (async () => {
          const flight = await fetchRoundtripData('POZ', 'ICN', months[i], months[j]);
          if(flight && flight.data && flight.data.MinPrice) {
            flightsCache.push(flight);
            // Sortujemy cache i ograniczamy do 10 najtańszych
            flightsCache = sortAndKeepCheapest(flightsCache, 10);
            console.log(`Pobrano: POZ → ICN ${months[i]} → ${months[j]} cena: ${flight.data.MinPrice}`);
          }
        })()
      );
    }
  }
  await Promise.all(tasks);
  lastRefresh = new Date();
  console.log(`[${new Date().toISOString()}] Refresh finished. Liczba wpisów w cache: ${flightsCache.length}`);
}

app.get('/api/flights', (req,res) => {
  res.json({ refreshed: lastRefresh, flights: flightsCache });
});

refreshFlights();
setInterval(refreshFlights, 15 * 60 * 1000);
app.listen(PORT, () => {
  console.log(`Serwer działa na http://localhost:${PORT}`);
});
