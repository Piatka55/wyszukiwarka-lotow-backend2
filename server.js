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
  { iata: 'SAW', country: 'Turkey', city: 'Istanbul Sabiha' },
];

let azjaFlightsCache = {};
let lastAzjaRefresh = null;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

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
      return { from, to, monthOutbound, month
