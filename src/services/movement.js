// Builds a real, observed time-series of "% of entries on each option" from
// actual prediction rows (World Cup free-game entries or market tickets).
// No synthetic data — every point is a running tally at an entry's real
// created_at timestamp. Downsampled so charts stay readable at high volume.
const MAX_POINTS = 60;

function buildMovementSeries(rows, options, field, tsField = 'created_at') {
  if (!rows?.length) return [];

  const keys   = options.map(o => (typeof o === 'string' ? o : o.key));
  const counts = Object.fromEntries(keys.map(k => [k, 0]));
  let total = 0;
  const allPoints = [];

  for (const row of rows) {
    const val = row[field];
    if (val == null) continue;
    if (counts[val] === undefined) counts[val] = 0; // tolerate stray values not in the configured option list
    counts[val] += 1;
    total += 1;

    const pcts = {};
    for (const k of Object.keys(counts)) {
      pcts[k] = total ? Math.round((counts[k] / total) * 1000) / 10 : 0;
    }
    allPoints.push({ ts: row[tsField], pcts });
  }

  if (allPoints.length <= MAX_POINTS) return allPoints;

  const step = allPoints.length / MAX_POINTS;
  const sampled = [];
  for (let i = 0; i < MAX_POINTS; i++) sampled.push(allPoints[Math.floor(i * step)]);
  sampled.push(allPoints[allPoints.length - 1]); // always keep the latest real point
  return sampled;
}

module.exports = { buildMovementSeries };
