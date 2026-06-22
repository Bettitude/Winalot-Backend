const CORNERS_LINES      = ['6.5', '7.5', '8.5', '9.5', '10.5'];
const GOALS_LINES        = ['0.5', '1.5', '2.5', '3.5', '4.5'];
const CARDS_LINES        = ['1.5', '2.5', '3.5', '4.5'];
const YELLOW_CARDS_LINES = ['1.5', '2.5', '3.5', '4.5'];
const RED_CARDS_LINES    = ['0.5', '1.5'];
const SHOTS_LINES        = ['8.5', '9.5', '10.5', '12.5'];
const OFFSIDES_LINES     = ['2.5', '3.5', '4.5', '5.5'];
const FOULS_LINES        = ['14.5', '17.5', '20.5', '23.5'];
const THROW_INS_LINES    = ['18.5', '21.5', '24.5'];

function normalizeType(t) {
  return (t || '').toLowerCase().replace(/[\s_-]+/g, '_');
}

function ovUn(lines) {
  return [
    ...lines.map(v => ({ label: `OV ${v}`, value: `OV ${v}` })),
    ...lines.map(v => ({ label: `UN ${v}`, value: `UN ${v}` })),
  ];
}

function generateOptions(marketType, homeTeam, awayTeam) {
  const mt = normalizeType(marketType);

  if (['match_result', 'result', 'scores', 'match result'].some(k => mt === k || mt.includes(k))) {
    return [
      { label: homeTeam || 'Home Win', value: homeTeam || 'Home Win' },
      { label: 'Draw',                  value: 'Draw' },
      { label: awayTeam || 'Away Win',  value: awayTeam || 'Away Win' },
    ];
  }
  if (mt.includes('corner')) return ovUn(CORNERS_LINES);
  if (mt.includes('goal') || mt === 'total_goals') {
    return [
      ...ovUn(GOALS_LINES),
      { label: 'BTTS Yes', value: 'BTTS Yes' },
      { label: 'BTTS No',  value: 'BTTS No'  },
    ];
  }
  // Check specific card types before the generic 'card' fallback
  if (mt.includes('yellow_card')) return ovUn(YELLOW_CARDS_LINES);
  if (mt.includes('red_card'))    return ovUn(RED_CARDS_LINES);
  if (mt.includes('card'))        return ovUn(CARDS_LINES);
  if (mt.includes('shot'))        return ovUn(SHOTS_LINES);
  if (mt.includes('offside'))     return ovUn(OFFSIDES_LINES);
  if (mt.includes('foul'))        return ovUn(FOULS_LINES);
  if (mt.includes('throw'))       return ovUn(THROW_INS_LINES);
  if (mt === 'btts') {
    return [
      { label: 'BTTS Yes', value: 'BTTS Yes' },
      { label: 'BTTS No',  value: 'BTTS No'  },
    ];
  }
  return [
    { label: 'Yes', value: 'Yes' },
    { label: 'No',  value: 'No'  },
  ];
}

/**
 * Given actual result (e.g. "8" for 8 corners), return the single best correct option.
 * OV/UN markets: highest OV line that cleared, or lowest UN if none cleared.
 */
function identifyCorrectOption(marketType, actualResult, homeTeam, awayTeam) {
  const mt = normalizeType(marketType);

  if (mt.includes('result') || mt === 'scores') {
    const map = { home: homeTeam || 'Home Win', draw: 'Draw', away: awayTeam || 'Away Win' };
    return map[(actualResult || '').toLowerCase()] || actualResult;
  }

  const actual = parseFloat(actualResult);
  let lines;

  if (mt.includes('corner'))           lines = CORNERS_LINES.map(Number);
  else if (mt.includes('goal'))        lines = GOALS_LINES.map(Number);
  else if (mt.includes('yellow_card')) lines = YELLOW_CARDS_LINES.map(Number);
  else if (mt.includes('red_card'))    lines = RED_CARDS_LINES.map(Number);
  else if (mt.includes('card'))        lines = CARDS_LINES.map(Number);
  else if (mt.includes('shot'))        lines = SHOTS_LINES.map(Number);
  else if (mt.includes('offside'))     lines = OFFSIDES_LINES.map(Number);
  else if (mt.includes('foul'))        lines = FOULS_LINES.map(Number);
  else if (mt.includes('throw'))       lines = THROW_INS_LINES.map(Number);
  else if (mt === 'btts') return actualResult === 'yes' ? 'BTTS Yes' : 'BTTS No';
  else return actualResult;

  if (isNaN(actual)) return null;

  const clearedOV = lines.filter(l => actual > l);
  if (clearedOV.length === 0) return `UN ${Math.min(...lines).toFixed(1)}`;
  return `OV ${Math.max(...clearedOV).toFixed(1)}`;
}

module.exports = { generateOptions, identifyCorrectOption };
