const mysql = require('mysql2/promise');
const fetch = require('node-fetch');

const API_URL = 'http://108.181.221.198:3000/api/azja-flights';

const dbConfig = {
  host: 'localhost',
  user: 'ndcovltcjg_Piatka55',
  password: 'Polska1923!',
  database: 'ndcovltcjg_Flights'
};

async function fetchAndSaveFlights() {
  const conn = await mysql.createConnection(dbConfig);

  const response = await fetch(API_URL);
  const data = await response.json();

  const flightsByCountry = data.flightsByCountry;
  const refreshedAt = new Date();

  await conn.beginTransaction();

  try {
    // Czyść starą zawartość tabeli (opcjonalnie)
    await conn.execute('DELETE FROM Flights');

    for (const countryKey in flightsByCountry) {
      const countryData = flightsByCountry[countryKey];
      if (!countryData || !countryData[0] || !countryData[0].data) continue;

      const traces = countryData[0].data.Traces;
      const priceGrid = countryData[0].data.PriceGrids.Grid;

      const traceMap = {};
      for (const traceId in traces) {
        const parts = traces[traceId].split('*');
        const dateString = parts[4];
        traceMap[traceId] = {
          from_airport: parts[2],
          to_airport: parts[3],
          date_out: `${dateString.substring(0, 4)}-${dateString.substring(4, 6)}-${dateString.substring(6, 8)}`
        };
      }

      for (const row of priceGrid) {
        for (const cell of row) {
          if (cell && cell.Indirect && cell.Indirect.Price && cell.Indirect.TraceRefs && cell.Indirect.TraceRefs.length === 2) {
            const outTrace = traceMap[cell.Indirect.TraceRefs[0]];
            const inTrace = traceMap[cell.Indirect.TraceRefs[1]];

            const price = cell.Indirect.Price;
            const dateBack = inTrace.date_out;
            const stayDays = Math.round((new Date(dateBack) - new Date(outTrace.date_out)) / (1000 * 60 * 60 * 24));

            // Wstaw do bazy z przykładowym airline i is_direct
            await conn.execute(
              `INSERT INTO Flights (refreshed_at, from_airport, to_airport, date_out, date_back, stay_days, airline, is_direct, price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [refreshedAt, outTrace.from_airport, outTrace.to_airport, outTrace.date_out, dateBack, stayDays, '', 0, price]
            );
          }
        }
      }
    }

    await conn.commit();
    console.log('Loty zapisane do bazy.');
  } catch (err) {
    await conn.rollback();
    console.error('Błąd zapisu:', err);
  } finally {
    await conn.end();
  }
}

fetchAndSaveFlights();
