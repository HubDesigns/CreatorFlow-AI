const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { pipeline } = require('stream/promises');
const { runFFmpeg } = require('./ffmpeg');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm']);
const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'around', 'beautiful', 'cinematic',
  'clear', 'conclusion', 'content', 'create', 'creating', 'for', 'from', 'good',
  'hook', 'into', 'introduction', 'into', 'lighting', 'like', 'memorable', 'natural',
  'opening', 'people', 'shot', 'shots', 'some', 'that', 'the', 'their', 'this',
  'with', 'without', 'video', 'visual', 'wide'
]);

function normalizeSearchQuery(value = '') {
  const words = String(value).toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 1 && !STOP_WORDS.has(word));
  return [...new Set(words)].slice(0, 7).join(' ').slice(0, 100) || 'nature landscape';
}

function scoreLocalFootage(filename, query) {
  const words = new Set(normalizeSearchQuery(query).split(/\s+/));
  const nameWords = new Set(path.basename(filename, path.extname(filename)).toLowerCase().split(/[^a-z0-9]+/));
  let score = 0;
  for (const word of words) if (nameWords.has(word)) score += 1;
  return score;
}

async function listVideoFiles(directory) {
  const files = [];
  async function walk(current, depth = 0) {
    if (depth > 3) return;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(fullPath, depth + 1);
      else if (entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(fullPath);
    }
  }
  await walk(directory);
  return files.sort();
}

class FootageFirstProvider {
  constructor(options = {}) {
    this.id = 'footage_first';
    this.model = 'Local footage + FFmpeg';
    this.capabilities = {
      minDuration: 1, maxDuration: 120, defaultResolution: '720p',
      text: true, firstFrame: true, nativeAudio: false, local: true,
      referenceImages: 0, referenceVideos: 0, referenceAudios: 0
    };
    this.directory = path.resolve(options.directory || process.env.FOOTAGE_LIBRARY_DIR || path.join(process.cwd(), 'data', 'footage'));
    this.cacheDirectory = path.resolve(options.cacheDirectory || path.join(process.cwd(), 'data', 'cache', 'pixabay-video-search'));
    this.apiKey = options.apiKey !== undefined ? options.apiKey : (process.env.PIXABAY_API_KEY || '');
    this.http = options.http || axios;
    this.hardwareProfile = options.hardwareProfile || null;
    this.ffmpeg = options.runFFmpeg || runFFmpeg;
    this.downloadTimeoutMs = Math.max(15000, Number(options.downloadTimeoutMs || 120000));
    this.maxDownloadBytes = Math.max(5 * 1024 * 1024, Number(options.maxDownloadBytes || 250 * 1024 * 1024));
  }

  isAvailable() {
    if (this.apiKey) return true;
    const hasVideo = directory => {
      try {
        return fsSync.readdirSync(directory, { withFileTypes: true }).some(entry => {
          const fullPath = path.join(directory, entry.name);
          return entry.isFile()
            ? VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
            : entry.isDirectory() && hasVideo(fullPath);
        });
      } catch (_error) {
        return false;
      }
    };
    return hasVideo(this.directory);
  }

  supports(request = {}) {
    const duration = Number(request.duration || 0);
    return !duration || (duration >= this.capabilities.minDuration && duration <= this.capabilities.maxDuration);
  }

  describe() {
    return {
      id: this.id,
      model: this.model,
      available: this.isAvailable(),
      capabilities: this.capabilities,
      source: this.apiKey ? 'local_library_or_pixabay' : 'local_library'
    };
  }

  normalizeRequest(request = {}) {
    return {
      ...request,
      prompt: String(request.prompt || '').slice(0, 2000),
      duration: Math.max(1, Math.min(120, Number(request.duration || 8))),
      resolution: request.resolution || '720p'
    };
  }

  async getProfile() {
    if (this.hardwareProfile) return this.hardwareProfile;
    try {
      const { detectHardwareProfile } = require('./hardware-profile');
      this.hardwareProfile = await detectHardwareProfile();
    } catch (_error) {
      this.hardwareProfile = { profile: 'integrated', defaultVideoMode: 'footage_first' };
    }
    return this.hardwareProfile;
  }

  async findLocalClip(query) {
    const files = await listVideoFiles(this.directory);
    const ranked = files.map(file => ({ file, score: scoreLocalFootage(file, query) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
    return ranked[0] || null;
  }

  async searchPixabay(query) {
    if (!this.apiKey) return null;
    const cacheKey = crypto.createHash('sha256').update(query.toLowerCase()).digest('hex');
    const cachePath = path.join(this.cacheDirectory, cacheKey + '.json');
    const now = Date.now();
    const cached = await fs.readFile(cachePath, 'utf8').then(JSON.parse).catch(() => null);
    if (cached?.expiresAt > now && Array.isArray(cached.hits)) return cached.hits;

    let response;
    try {
      response = await this.http.get('https://pixabay.com/api/videos/', {
        params: { key: this.apiKey, q: query, per_page: 12, safesearch: 'true', order: 'popular' },
        timeout: 20000
      });
    } catch (error) {
      const status = Number(error?.response?.status) || null;
      const message = status === 429
        ? 'Pixabay rate limit reached; cached results will be reused after the provider limit resets.'
        : status === 401 || status === 403
          ? 'Pixabay rejected the configured API key. Check PIXABAY_API_KEY in your local .env file.'
          : `Pixabay video search failed${status ? ` (HTTP ${status})` : ' because of a network error'}.`;
      const safeError = new Error(message);
      safeError.code = 'PIXABAY_SEARCH_FAILED';
      throw safeError;
    }
    const hits = Array.isArray(response.data?.hits) ? response.data.hits : [];
    await fs.mkdir(this.cacheDirectory, { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify({ expiresAt: now + 24 * 60 * 60 * 1000, hits }, null, 2));
    return hits;
  }

  choosePixabayFile(hit, profile) {
    const videos = hit?.videos || {};
    const preference = profile?.profile === 'high_gpu'
      ? ['medium', 'small', 'tiny']
      : ['entry_gpu', 'integrated_plus'].includes(profile?.profile)
        ? ['small', 'tiny', 'medium']
        : ['tiny', 'small'];
    for (const size of preference) {
      const file = videos[size];
      if (file?.url && Number(file.size || 0) <= this.maxDownloadBytes) return { ...file, quality: size };
    }
    return null;
  }

  async downloadToFile(url, destination) {
    const response = await this.http.get(url, {
      responseType: 'stream',
      timeout: this.downloadTimeoutMs,
      maxContentLength: this.maxDownloadBytes,
      maxBodyLength: this.maxDownloadBytes
    });
    const declaredLength = Number(response.headers?.['content-length'] || 0);
    if (declaredLength > this.maxDownloadBytes) throw new Error('Selected stock clip exceeds the configured download size limit');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await pipeline(response.data, fsSync.createWriteStream(destination));
    const stat = await fs.stat(destination);
    if (!stat.size || stat.size > this.maxDownloadBytes) {
      await fs.unlink(destination).catch(() => {});
      throw new Error('Downloaded stock clip was empty or exceeded the configured size limit');
    }
    return destination;
  }

  async createTask(input = {}) {
    const request = this.normalizeRequest(input);
    const query = normalizeSearchQuery(input.searchQuery || request.prompt);
    const local = await this.findLocalClip(query);
    if (local) {
      return {
        externalTaskId: 'local_' + crypto.createHash('sha1').update(local.file).digest('hex').slice(0, 12),
        status: 'succeeded',
        outputUrl: local.file,
        duration: request.duration,
        resolution: request.resolution,
        model: this.model,
        source: {
          provider: 'local_library',
          file: path.basename(local.file),
          attribution: 'User-provided local footage'
        },
        error: null
      };
    }

    if (!this.apiKey) {
      const error = new Error(
        'No matching local footage was found. Add licensed video files to data/footage (use descriptive filenames), or configure a free Pixabay API key as PIXABAY_API_KEY. No paid provider or slideshow fallback was used.'
      );
      error.code = 'FOOTAGE_NOT_FOUND';
      throw error;
    }

    const hits = await this.searchPixabay(query);
    if (!hits.length) {
      const error = new Error('Pixabay returned no stock footage for: ' + query);
      error.code = 'FOOTAGE_NOT_FOUND';
      throw error;
    }
    const profile = await this.getProfile();
    const selected = hits.map(hit => ({ hit, file: this.choosePixabayFile(hit, profile) }))
      .find(item => item.file);
    if (!selected) throw new Error('Pixabay returned clips but none met the local download-size limit');

    const tempPath = path.join(path.dirname(input.outputPath || this.directory), '.footage-download-' + crypto.randomBytes(8).toString('hex') + '.mp4');
    await this.downloadToFile(selected.file.url, tempPath);
    return {
      externalTaskId: 'pixabay_' + selected.hit.id,
      status: 'succeeded',
      outputUrl: tempPath,
      duration: request.duration,
      resolution: request.resolution,
      model: this.model,
      tempPath,
      source: {
        provider: 'Pixabay',
        id: selected.hit.id,
        pageUrl: selected.hit.pageURL,
        creator: selected.hit.user,
        creatorId: selected.hit.user_id,
        duration: selected.hit.duration,
        tags: selected.hit.tags,
        quality: selected.file.quality,
        attribution: 'Footage provided by Pixabay'
      },
      error: null
    };
  }

  async getTask(id) {
    return { externalTaskId: id, status: 'failed', outputUrl: null, error: 'Footage downloads are synchronous and cannot be resumed after restart' };
  }

  async downloadResult(task, outputPath) {
    if (!task.outputUrl || !fsSync.existsSync(task.outputUrl)) throw new Error('Selected footage file is missing');
    const profile = await this.getProfile();
    const maxWidth = profile.profile === 'high_gpu' ? 1920 : profile.profile === 'integrated' ? 960 : 1280;
    const resolutionWidths = { '360p': 640, '480p': 854, '540p': 960, '720p': 1280, '1080p': 1920 };
    const requestedWidth = resolutionWidths[String(task.resolution || '').toLowerCase()] || maxWidth;
    const width = Math.min(maxWidth, requestedWidth);
    const height = Math.round(width * 9 / 16);
    const duration = Math.max(1, Math.min(120, Number(task.duration || process.env.VIDEO_CLIP_DURATION || 8)));
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await this.ffmpeg([
      '-y', '-stream_loop', '-1', '-i', task.outputUrl,
      '-t', String(duration),
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=24`,
      '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '25',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputPath
    ]);
    if (task.tempPath) await fs.unlink(task.tempPath).catch(() => {});
    return outputPath;
  }
}

module.exports = { FootageFirstProvider, normalizeSearchQuery, scoreLocalFootage, listVideoFiles };
