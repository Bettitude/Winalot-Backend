const { newsClient } = require('../lib/httpClient');
const { getCached, setCache } = require('../lib/redis');

async function getSoccerNews(limit = 10) {
  const cacheKey = `news:soccer:${limit}`;
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  try {
    const res = await newsClient.get('/news/all', {
      params: {
        api_token:  process.env.NEWS_API_KEY,
        search:     'football OR soccer',
        categories: 'sports',
        language:   'en',
        limit,
      },
    });

    const articles = (res.data.data || []).map(a => ({
      title:       a.title,
      description: a.description,
      image:       a.image_url,
      url:         a.url,
      source:      a.source,
      publishedAt: a.published_at,
    }));

    await setCache(cacheKey, articles, 900);
    return articles;
  } catch (err) {
    console.error('[newsService] News API failed:', err.message);
    return [];
  }
}

async function getNewsForTeam(teamName, limit = 5) {
  const cacheKey = `news:team:${teamName.toLowerCase().replace(/\s/g, '_')}:${limit}`;
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  try {
    const res = await newsClient.get('/news/all', {
      params: {
        api_token:  process.env.NEWS_API_KEY,
        search:     teamName,
        categories: 'sports',
        language:   'en',
        limit,
      },
    });

    const articles = (res.data.data || []).map(a => ({
      title:       a.title,
      description: a.description,
      image:       a.image_url,
      url:         a.url,
      publishedAt: a.published_at,
    }));

    await setCache(cacheKey, articles, 900);
    return articles;
  } catch (err) {
    console.error('[newsService] News API failed for team:', err.message);
    return [];
  }
}

module.exports = { getSoccerNews, getNewsForTeam };
