const { IS_DB_CONFIGURED } = require('./db');

// Run in mock/API-Football mode when MySQL isn't configured
const IS_MOCK = !IS_DB_CONFIGURED;

const TIERS = [
  { tier: 'silver',   ticket_price: 100,  fill: 42 },
  { tier: 'gold',     ticket_price: 500,  fill: 27 },
  { tier: 'platinum', ticket_price: 2500, fill: 11 },
];

/**
 * Convert a raw API-Football fixture into the shape the frontend's
 * normalizeMatch() expects (matches the winalott_db row format).
 */
function fixtureToMatch(f) {
  const fixtureId = f.fixture?.id;
  const home      = f.teams?.home;
  const away      = f.teams?.away;
  const league    = f.league;
  const status    = f.fixture?.status?.short;

  const matchStatus =
    status === 'NS' ? 'active' :
    ['1H','2H','HT','ET','BT','P'].includes(status) ? 'live' :
    status === 'FT' ? 'finished' : 'active';

  const markets = TIERS.map(t => ({
    id:                 `${fixtureId}_${t.tier}`,
    match_id:           String(fixtureId),
    name:               'Match Result',
    description:        'Predict the full-time result of this match.',
    type:               'result',
    tier:               t.tier,
    ticket_price:       t.ticket_price,
    min_entry_fee:      t.ticket_price,
    max_entry_fee:      t.ticket_price,
    max_tickets:        200,
    fill_percent:       t.fill,
    correct_prediction: null,
    status:             'active',
    options: [
      { label: home?.name || 'Home Win', value: 'home' },
      { label: 'Draw',                   value: 'draw' },
      { label: away?.name || 'Away Win', value: 'away' },
    ],
  }));

  const elapsed = f.fixture?.status?.elapsed;

  return {
    id:                 String(fixtureId),
    title:              `${home?.name || 'Home'} vs ${away?.name || 'Away'}`,
    team_home:          home?.name  || 'Home Team',
    team_away:          away?.name  || 'Away Team',
    home_logo:          home?.logo  || null,
    away_logo:          away?.logo  || null,
    team_home_id:       home?.id    || null,
    team_away_id:       away?.id    || null,
    league:             league?.name || 'Unknown League',
    league_id:          league?.id  || null,
    league_logo:        league?.logo || null,
    stadium:            f.fixture?.venue?.name || null,
    match_date:         f.fixture?.date || new Date().toISOString(),
    ticket_sales_close: f.fixture?.date || new Date().toISOString(),
    status:             matchStatus,
    score: {
      home: f.goals?.home ?? null,
      away: f.goals?.away ?? null,
    },
    minute:             elapsed != null ? `${elapsed}'` : null,
    api_fixture_id:     fixtureId,
    markets,
  };
}

module.exports = { IS_MOCK, fixtureToMatch };
