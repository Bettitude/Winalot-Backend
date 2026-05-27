const { IS_DB_CONFIGURED } = require('./db');

// Run in mock/API-Football mode when MySQL isn't configured
const IS_MOCK = !IS_DB_CONFIGURED;

/**
 * All market types generated per fixture.
 * name must match the MarketFilterTabs labels exactly.
 */
const MARKET_DEFS = [
  {
    type: 'result',
    name: 'Match Result',
    tier: 'silver',
    ticket_price: 100,
    fill: 42,
    getOptions: (h, a) => [
      { label: h || 'Home Win', value: 'home' },
      { label: 'Draw',          value: 'draw' },
      { label: a || 'Away Win', value: 'away' },
    ],
  },
  {
    type: 'btts',
    name: 'BTTS',
    tier: 'silver',
    ticket_price: 100,
    fill: 38,
    getOptions: () => [
      { label: 'Yes – Both Teams Score', value: 'yes' },
      { label: 'No – Clean Sheet',       value: 'no'  },
    ],
  },
  {
    type: 'corners',
    name: 'Corners',
    tier: 'gold',
    ticket_price: 500,
    fill: 27,
    getOptions: () => [
      { label: 'Under 9.5 Corners', value: 'under' },
      { label: 'Over 9.5 Corners',  value: 'over'  },
    ],
  },
  {
    type: 'cards',
    name: 'Total Cards',
    tier: 'silver',
    ticket_price: 100,
    fill: 31,
    getOptions: () => [
      { label: 'Under 3.5 Cards', value: 'under' },
      { label: 'Over 3.5 Cards',  value: 'over'  },
    ],
  },
  {
    type: 'goalscorer',
    name: 'Goal Scorer',
    tier: 'gold',
    ticket_price: 500,
    fill: 19,
    getOptions: (h, a) => [
      { label: `${h || 'Home'} Player Scores`, value: 'home'    },
      { label: `${a || 'Away'} Player Scores`, value: 'away'    },
      { label: 'No Goal Scored',               value: 'no_goal' },
    ],
  },
  {
    type: 'shots',
    name: 'Shots',
    tier: 'silver',
    ticket_price: 100,
    fill: 24,
    getOptions: () => [
      { label: 'Under 24.5 Total Shots', value: 'under' },
      { label: 'Over 24.5 Total Shots',  value: 'over'  },
    ],
  },
  {
    type: 'penalty',
    name: 'Penalty',
    tier: 'gold',
    ticket_price: 500,
    fill: 15,
    getOptions: () => [
      { label: 'Yes – Penalty Awarded', value: 'yes' },
      { label: 'No Penalty',            value: 'no'  },
    ],
  },
  {
    type: 'scores',
    name: 'Scores',
    tier: 'platinum',
    ticket_price: 2500,
    fill: 11,
    getOptions: () => [
      { label: '1 – 0', value: '1-0' },
      { label: '0 – 1', value: '0-1' },
      { label: '1 – 1', value: '1-1' },
      { label: '2 – 0', value: '2-0' },
      { label: '0 – 2', value: '0-2' },
      { label: '2 – 1', value: '2-1' },
    ],
  },
  {
    type: 'throwins',
    name: 'Throw Ins',
    tier: 'silver',
    ticket_price: 100,
    fill: 21,
    getOptions: () => [
      { label: 'Under 29.5 Throw Ins', value: 'under' },
      { label: 'Over 29.5 Throw Ins',  value: 'over'  },
    ],
  },
  {
    type: 'fouls',
    name: 'Fouls',
    tier: 'silver',
    ticket_price: 100,
    fill: 33,
    getOptions: () => [
      { label: 'Under 20.5 Fouls', value: 'under' },
      { label: 'Over 20.5 Fouls',  value: 'over'  },
    ],
  },
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

  const markets = MARKET_DEFS.map(def => ({
    id:                 `${fixtureId}_${def.type}`,
    match_id:           String(fixtureId),
    name:               def.name,
    description:        `Predict the ${def.name.toLowerCase()} outcome for this match.`,
    type:               def.type,
    tier:               def.tier,
    ticket_price:       def.ticket_price,
    min_entry_fee:      def.ticket_price,
    max_entry_fee:      def.ticket_price,
    max_tickets:        200,
    fill_percent:       def.fill,
    correct_prediction: null,
    status:             'active',
    options:            def.getOptions(home?.name, away?.name),
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
