// Money Sniffer — backend proxy
//
// Why this exists: the frontend (fundamental.js) cannot safely call FRED or ECB
// directly from the browser. FRED requires an API key (which must never sit in
// client-side code) and does not send CORS headers that allow browser fetches
// from arbitrary origins. The ECB API is keyless, but routing it through the
// same backend keeps caching, error handling, and the "is this real or sample
// data" logic in one place instead of duplicated in the browser.
//
// This server exposes ONE endpoint the frontend calls:
//   GET /api/fundamentals
// It returns an array of currency objects shaped exactly like the sample data
// fundamental.js already uses, plus a `source` field per currency so the UI
// can show whether a number is real or still a placeholder.

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;
const FRED_API_KEY = process.env.FRED_API_KEY;

app.use(cors()); // allow the frontend (opened from file:// or localhost) to call this server

// ---- Simple in-memory cache -------------------------------------------------
// Macro data updates at most monthly/quarterly, so there is no reason to hit
// FRED/ECB on every page load. Cache for 6 hours.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let cache = { data: null, fetchedAt: 0 };

// ---- FRED (United States) ---------------------------------------------------
// Series IDs are stable, well-documented FRED identifiers:
//   FEDFUNDS = Effective Federal Funds Rate
//   CPIAUCSL (units=pc1) = CPI, % change from year ago
//   GDPC1 (units=pc1)    = Real GDP, % change from year ago
//   UNRATE = Unemployment rate
// FRED has no free, reliable PMI series (ISM data is proprietary), so PMI stays
// a manually-entered placeholder until you wire a paid source for it.
async function fetchFredSeries(seriesId, units) {
  if (!FRED_API_KEY) throw new Error('FRED_API_KEY not set');
  const params = new URLSearchParams({
    series_id: seriesId,
    api_key: FRED_API_KEY,
    file_type: 'json',
    sort_order: 'desc',
    limit: '1',
  });
  if (units) params.set('units', units);
  const url = `https://api.stlouisfed.org/fred/series/observations?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${seriesId} failed: ${res.status}`);
  const json = await res.json();
  const obs = json.observations?.[0];
  if (!obs || obs.value === '.') throw new Error(`FRED ${seriesId} returned no usable value`);
  return parseFloat(obs.value);
}

async function fetchUSD() {
  const [rate, cpi, gdp, unemp] = await Promise.all([
    fetchFredSeries('FEDFUNDS'),
    fetchFredSeries('CPIAUCSL', 'pc1'),
    fetchFredSeries('GDPC1', 'pc1'),
    fetchFredSeries('UNRATE'),
  ]);
  return { rate, cpi, gdp, unemp, pmi: null, source: 'real', sourceNote: 'FRED (Federal Reserve)' };
}

// ---- ECB (Eurozone) ----------------------------------------------------------
// As of Feb 2026 the ECB retired the old "ICP" dataset in favour of "HICP" —
// if you find older tutorials online using ICP.M.U2..., they are stale.
//   FM/D.U2.EUR.4F.KR.DFR.LEV        = Deposit Facility Rate (ECB's main policy signal since Sep 2023)
//   HICP/M.U2.N.000000.4D0.ANR       = HICP inflation, annual rate of change
async function fetchEcbSeries(flow, key) {
  const url = `https://data-api.ecb.europa.eu/service/data/${flow}/${key}?format=csvdata&lastNObservations=1`;
  const res = await fetch(url, { headers: { Accept: 'text/csv' } });
  if (!res.ok) throw new Error(`ECB ${flow}/${key} failed: ${res.status}`);
  const csv = await res.text();
  const lines = csv.trim().split('\n');
  const header = lines[0].split(',');
  const last = lines[lines.length - 1].split(',');
  const valueIdx = header.indexOf('OBS_VALUE');
  if (valueIdx === -1) throw new Error(`ECB ${flow}/${key}: OBS_VALUE column not found`);
  return parseFloat(last[valueIdx]);
}

async function fetchEUR() {
  const [rate, cpi] = await Promise.all([
    fetchEcbSeries('FM', 'D.U2.EUR.4F.KR.DFR.LEV'),
    fetchEcbSeries('HICP', 'M.U2.N.000000.4D0.ANR'),
  ]);
  // GDP growth, unemployment and PMI for the euro area aren't wired yet —
  // Eurostat's API is the natural next source for those.
  return {
    rate, cpi,
    gdp: null, unemp: null, pmi: null,
    source: 'partial',
    sourceNote: 'ECB (sazba + inflace reálně, zbytek zatím chybí)',
  };
}

// ---- Sample fallback for currencies not wired to a live source yet ----------
const SAMPLE = {
  GBP: { rate: 4.00, cpi: 2.9, gdp: 1.0, unemp: 4.5, pmi: 50.2 },
  JPY: { rate: 0.50, cpi: 2.8, gdp: 0.7, unemp: 2.5, pmi: 49.1 },
  CHF: { rate: 0.25, cpi: 0.6, gdp: 1.3, unemp: 2.4, pmi: 50.9 },
  CAD: { rate: 2.75, cpi: 2.2, gdp: 1.4, unemp: 6.6, pmi: 49.5 },
  AUD: { rate: 3.85, cpi: 2.7, gdp: 1.9, unemp: 4.1, pmi: 51.0 },
  NZD: { rate: 3.00, cpi: 2.3, gdp: 1.5, unemp: 5.0, pmi: 50.4 },
};

const META = {
  USD: { name: 'Americký dolar', flag: '🇺🇸' },
  EUR: { name: 'Euro', flag: '🇪🇺' },
  GBP: { name: 'Britská libra', flag: '🇬🇧' },
  JPY: { name: 'Japonský jen', flag: '🇯🇵' },
  CHF: { name: 'Švýcarský frank', flag: '🇨🇭' },
  CAD: { name: 'Kanadský dolar', flag: '🇨🇦' },
  AUD: { name: 'Australský dolar', flag: '🇦🇺' },
  NZD: { name: 'Novozélandský dolar', flag: '🇳🇿' },
};

async function buildFundamentals() {
  const result = [];

  // USD — real, via FRED (requires FRED_API_KEY)
  try {
    result.push({ code: 'USD', ...META.USD, ...(await fetchUSD()) });
  } catch (err) {
    console.error('USD fetch failed, falling back to sample:', err.message);
    result.push({ code: 'USD', ...META.USD, rate: 4.75, cpi: 2.6, gdp: 2.1, unemp: 4.2, pmi: 51.3, source: 'sample', sourceNote: `Fallback — FRED nedostupný (${err.message})` });
  }

  // EUR — partial real, via ECB
  try {
    result.push({ code: 'EUR', ...META.EUR, ...(await fetchEUR()) });
  } catch (err) {
    console.error('EUR fetch failed, falling back to sample:', err.message);
    result.push({ code: 'EUR', ...META.EUR, rate: 2.25, cpi: 2.1, gdp: 1.2, unemp: 6.3, pmi: 49.8, source: 'sample', sourceNote: `Fallback — ECB nedostupné (${err.message})` });
  }

  // Everything else — still sample data, clearly labelled
  for (const code of Object.keys(SAMPLE)) {
    result.push({ code, ...META[code], ...SAMPLE[code], source: 'sample', sourceNote: 'Zdroj zatím nenapojen' });
  }

  return result;
}

app.get('/api/fundamentals', async (req, res) => {
  const now = Date.now();
  if (cache.data && now - cache.fetchedAt < CACHE_TTL_MS) {
    return res.json({ data: cache.data, cached: true, fetchedAt: cache.fetchedAt });
  }
  try {
    const data = await buildFundamentals();
    cache = { data, fetchedAt: now };
    res.json({ data, cached: false, fetchedAt: now });
  } catch (err) {
    console.error('buildFundamentals failed:', err);
    res.status(500).json({ error: 'Failed to build fundamentals', message: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Money Sniffer backend running on http://localhost:${PORT}`);
  if (!FRED_API_KEY) {
    console.warn('⚠️  FRED_API_KEY not set — USD will fall back to sample data. See .env.example.');
  }
});
