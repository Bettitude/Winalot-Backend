const { oddsClient, apiFootballClient } = require('../lib/httpClient');
const { getCached, setCache } = require('../lib/redis');

const SOCCER_KEY = 'soccer';

async function getMatchOdds(homeTeam, awayTeam) {
  const cacheKey = `odds:${homeTeam}:${awayTeam}`.toLowerCase().replace(/\s/g, '_');
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  try {
    const res = await oddsClient.get(`/sports/${SOCCER_KEY}/odds`, {
      params: {
        apiKey:      process.env.ODDS_API_KEY,
        regions:     'uk,eu,us',
        markets:     'h2h,totals,btts',
        oddsFormat:  'decimal',
      },
    });

    const remaining = res.headers['x-requests-remaining'];
    if (remaining) console.log(`[oddsService] Requests remaining: ${remaining}`);

    const match = res.data.find(event =>
      event.home_team?.toLowerCase().includes(homeTeam?.toLowerCase() || '') ||
      event.away_team?.toLowerCase().includes(awayTeam?.toLowerCase() || '')
    );

    const data = match?.bookmakers || [];
    await setCache(cacheKey, data, 60);
    return data;
  } catch (err) {
    console.error('[oddsService] Odds API failed, falling back:', err.message);
    try {
      const res = await apiFootballClient.get('/odds', {
        params: { league: 39, season: new Date().getFullYear(), bookmaker: 6 },
      });
      return res.data.response || [];
    } catch {
      return [];
    }
  }
}

async function getLiveOdds() {
  const cacheKey = 'odds:live';
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  try {
    const res = await oddsClient.get(`/sports/${SOCCER_KEY}/odds-live`, {
      params: {
        apiKey:     process.env.ODDS_API_KEY,
        regions:    'uk,eu',
        markets:    'h2h',
        oddsFormat: 'decimal',
      },
    });
    const data = res.data;
    await setCache(cacheKey, data, 30);
    return data;
  } catch (err) {
    console.error('[oddsService] getLiveOdds failed:', err.message);
    return [];
  }
}

async function getOddsLeagues() {
  const cacheKey = 'odds:leagues';
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  try {
    const res = await oddsClient.get('/sports', {
      params: { apiKey: process.env.ODDS_API_KEY, all: false },
    });
    const soccerLeagues = res.data.filter(s =>
      s.group?.toLowerCase().includes('soccer') ||
      s.group?.toLowerCase().includes('football')
    );
    await setCache(cacheKey, soccerLeagues, 86400);
    return soccerLeagues;
  } catch (err) {
    console.error('[oddsService] getOddsLeagues failed:', err.message);
    return [];
  }
}

module.exports = { getMatchOdds, getLiveOdds, getOddsLeagues };
