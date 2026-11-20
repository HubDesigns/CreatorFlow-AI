const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { pipeline } = require('stream/promises');

const STOP_WORDS = new Set(['about', 'after', 'also', 'and', 'are', 'around', 'for', 'from', 'into', 'that', 'the', 'this', 'with', 'your', 'how', 'what']);

function normalizeImageQuery(value = '') {
  const words = String(value).toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 1 && !STOP_WORDS.has(word));
  return [...new Set(words)].slice(0, 7).join(' ').slice(0, 100) || 'nature landscape';
}

async function searchPixabayImages(query, options = {}) {
  const apiKey = options.apiKey !== undefined ? options.apiKey : (process.env.PIXABAY_API_KEY || '');
  if (!apiKey) return { images: [], sources: [] };

  const http = options.http || axios;
  const cacheDirectory = path.resolve(options.cacheDirectory || path.join(process.cwd(), 'data', 'cache', 'pixabay-image-search'));
  const downloadDirectory = path.resolve(options.downloadDirectory || path.join(process.cwd(), 'data', 'cache', 'pixabay-images'));
  const limit = Math.max(1, Math.min(8, Number(options.limit || 4)));
  const normalizedQuery = normalizeImageQuery(query);
  const cacheKey = crypto.createHash('sha256').update(normalizedQuery.toLowerCase()).digest('hex');
  const cachePath = path.join(cacheDirectory, cacheKey + '.json');
  const now = Date.now();
  let cached = await fs.readFile(cachePath, 'utf8').then(JSON.parse).catch(() => null);
  let hits = cached?.expiresAt > now && Array.isArray(cached.hits) ? cached.hits : null;

  if (!hits) {
    let response;
    try {
      response = await http.get('https://pixabay.com/api/', {
        params: {
          key: apiKey,
          q: normalizedQuery,
          image_type: 'photo',
          orientation: 'horizontal',
          per_page: 12,
          safesearch: 'true',
          order: 'popular'
        },
        timeout: 20000
      });
    } catch (error) {
      const status = Number(error?.response?.status) || null;
      const message = status === 429
        ? 'Pixabay image rate limit reached.'
        : status === 401 || status === 403
          ? 'Pixabay rejected the configured API key for image search.'
          : `Pixabay image search failed${status ? ` (HTTP ${status})` : ' because of a network error'}.`;
      const safeError = new Error(message);
      safeError.code = 'PIXABAY_IMAGE_SEARCH_FAILED';
      throw safeError;
    }
    hits = Array.isArray(response.data?.hits) ? response.data.hits : [];
    await fs.mkdir(cacheDirectory, { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify({ expiresAt: now + 24 * 60 * 60 * 1000, hits }, null, 2));
  }

  await fs.mkdir(downloadDirectory, { recursive: true });
  const images = [];
  const sources = [];
  for (const hit of hits) {
    if (images.length >= limit) break;
    if (!hit?.id || !hit.webformatURL) continue;
    const tags = String(hit.tags || '').split(',').map(tag => tag.trim()).filter(Boolean);
    const filenameTags = tags.slice(0, 5).join('-').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 55);
    const extension = path.extname(new URL(hit.webformatURL).pathname).toLowerCase() || '.jpg';
    const destination = path.join(downloadDirectory, `pixabay-${hit.id}-${filenameTags || 'stock'}${extension}`);

    try {
      const existing = await fs.stat(destination).catch(() => null);
      if (!existing?.isFile() || existing.size < 100) {
        const response = await http.get(hit.webformatURL, {
          responseType: 'stream',
          timeout: 30000,
          maxContentLength: 15 * 1024 * 1024,
          maxBodyLength: 15 * 1024 * 1024
        });
        const declaredLength = Number(response.headers?.['content-length'] || 0);
        if (declaredLength > 15 * 1024 * 1024) continue;
        await pipeline(response.data, fsSync.createWriteStream(destination));
      }
      const stat = await fs.stat(destination);
      if (stat.size < 100 || stat.size > 15 * 1024 * 1024) {
        await fs.unlink(destination).catch(() => {});
        continue;
      }
      images.push(destination);
      sources.push({
        provider: 'Pixabay',
        id: hit.id,
        pageUrl: hit.pageURL,
        creator: hit.user,
        creatorId: hit.user_id,
        tags: hit.tags,
        attribution: 'Photo provided by Pixabay'
      });
    } catch (_error) {
      // A single inaccessible image should not discard other valid results.
    }
  }
  return { images, sources, query: normalizedQuery };
}

module.exports = { normalizeImageQuery, searchPixabayImages };
