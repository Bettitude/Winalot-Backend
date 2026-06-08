const { IS_DB_CONFIGURED } = require('./db');

// Run in mock/API-Football mode when MySQL isn't configured
const IS_MOCK = !IS_DB_CONFIGURED;

/**
 * All market types generated per fixture.
 * name must match the MarketFilterTabs labels exactly.
 */
const { generateOptions } = require('./marketOptionsHelper');

const MARKET_DEFS = [
  { type: 'result',     name: 'Match Result', tier: 'silver',   ticket_price: 100,  fill: 42, prediction_type: 'market_type' },
  { type: 'btts',       name: 'BTTS',         tier: 'silver',   ticket_price: 100,  fill: 38, prediction_type: 'market_pick', admin_pick: 'Both Teams to Score' },
  { type: 'corners',    name: 'Corners',      tier: 'gold',     ticket_price: 500,  fill: 27, prediction_type: 'market_type' },
  { type: 'cards',      name: 'Total Cards',  tier: 'silver',   ticket_price: 100,  fill: 31, prediction_type: 'market_type' },
  { type: 'goalscorer', name: 'Goal Scorer',  tier: 'gold',     ticket_price: 500,  fill: 19, prediction_type: 'api_pick', admin_pick: 'Home team wins this match' },
  { type: 'shots',      name: 'Shots',        tier: 'silver',   ticket_price: 100,  fill: 24, prediction_type: 'market_type' },
  { type: 'penalty',    name: 'Penalty',      tier: 'gold',     ticket_price: 500,  fill: 15, prediction_type: 'api_pick', admin_pick: 'At least one penalty in this match' },
  { type: 'scores',     name: 'Scores',       tier: 'platinum', ticket_price: 2500, fill: 11, prediction_type: 'market_pick', admin_pick: '1 – 0' },
  { type: 'throwins',   name: 'Throw Ins',    tier: 'silver',   ticket_price: 100,  fill: 21, prediction_type: 'market_pick', admin_pick: 'Over 29.5 Throw Ins' },
  { type: 'fouls',      name: 'Fouls',        tier: 'silver',   ticket_price: 100,  fill: 33, prediction_type: 'market_pick', admin_pick: 'Over 20.5 Fouls' },
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

  const markets = MARKET_DEFS.map(def => {
    const opts = generateOptions(def.type, home?.name, away?.name);
    return {
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
      prediction_type:    def.prediction_type || 'market_pick',
      admin_pick:         def.admin_pick || null,
      auto_options:       def.prediction_type === 'market_type' ? opts : null,
      status:             'active',
      options:            opts,
    };
  });

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
