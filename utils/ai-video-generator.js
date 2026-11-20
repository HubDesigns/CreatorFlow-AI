const OpenAI = require('openai');
const Replicate = require('replicate');
const fs = require('fs').promises;
const path = require('path');
const { spawn: nodeSpawn } = require('child_process');
const axios = require('axios');
const sharp = require('sharp');
const { Logger } = require('./logger');
const { runFFmpeg, getMediaDuration, checkFFmpeg, ffmpegInstallHint } = require('./ffmpeg');
const { MediaGenerationService } = require('./media-generation-service');

const OPENAI_IMAGE_MODEL = 'gpt-image-2';

// Turns an image provider SDK error into one readable line that leads with the
// fix when the cause is recognisable. @google/genai puts the raw JSON error
// body in error.message, which is unreadable on a console.
function describeImageProviderError(provider, model, error) {
  const raw = String(error?.message || error || 'Unknown error');
  let status = Number(error?.status) || null;
  let code = String(error?.code || '');
  let detail = raw;
  try {
    const body = JSON.parse(raw.slice(raw.indexOf('{')));
    if (body?.error) {
      status = status || Number(body.error.code) || null;
      code = body.error.status || code;
      detail = body.error.message || raw;
    }
  } catch (_error) { /* not a JSON error body */ }

  const text = `${code} ${detail}`;
  let fix = null;
  if (provider === 'Gemini') {
    if (/limit:\s*0\b/i.test(text) || (status === 429 && /free.?tier/i.test(text))) {
      fix = `this key has no quota for ${model}. Gemini image models are not on the free tier: turn on billing for the Google Cloud project that owns this API key (AI Studio → API keys → Set up billing). A paid account does not help if the key belongs to a different project.`;
    } else if (status === 429 || /RESOURCE_EXHAUSTED/i.test(code)) {
      fix = 'Gemini rate-limited this key. Wait a minute and retry, or raise the project quota.';
    } else if (/API key not valid|API key expired|API_KEY_INVALID/i.test(text)) {
      fix = 'the Gemini API key was rejected. Create a new key in Google AI Studio and save it in Settings.';
    } else if (/location is not supported|user location/i.test(text)) {
      fix = 'Gemini image generation is not available in your region for this key.';
    } else if (status === 404 || /NOT_FOUND|not supported for generateContent/i.test(text)) {
      fix = `${model} is not available to this key. Set GEMINI_IMAGE_MODEL to an image model your key can use (for example gemini-3.1-flash-image).`;
    } else if (status === 403 || /PERMISSION_DENIED|SERVICE_DISABLED/i.test(text)) {
      fix = "this key's Google Cloud project cannot call the Gemini API. Enable the Generative Language API for that project, or create the key in Google AI Studio.";
    }
  } else if (provider === 'OpenAI') {
    if (status === 401 || /invalid_api_key|Incorrect API key/i.test(text)) {
      fix = 'the OpenAI API key was rejected. Check the key in Settings.';
    } else if (/insufficient_quota|billing/i.test(text)) {
      fix = 'the OpenAI account has no remaining credit. Add billing at platform.openai.com.';
    } else if (status === 403 && /verif/i.test(text)) {
      fix = `${model} requires a verified OpenAI organization (platform.openai.com → Settings → Organization → Verify).`;
    } else if (status === 429) {
      fix = 'OpenAI rate-limited this key. Wait a minute and retry.';
    }
  }

  const label = [status, code && code !== String(status) ? code : null].filter(Boolean).join(' ');
  const summary = `${provider} image generation (${model}) failed${label ? ` [${label}]` : ''}.`;
  const shortDetail = detail.replace(/\s+/g, ' ').trim().slice(0, 220);
  return fix ? `${summary} Fix: ${fix} Details: ${shortDetail}` : `${summary} ${shortDetail}`;
}

class AIVideoGenerator {
  constructor(credentials, options = {}) {
    this.logger = new Logger('AIVideoGenerator');
    const resolvedCredentials = credentials?.credentials || credentials || {};
    this.db = options.db || null;
    this.getMediaDuration = options.getMediaDuration || getMediaDuration;
    this.lastVideoResult = null;
    this.lastNarrationResult = null;
    this.spawn = options.spawn || nodeSpawn;
    this.runFFmpeg = options.runFFmpeg || runFFmpeg;
    this.platform = options.platform || process.platform;
    this.hardwareProfile = options.hardwareProfile || null;
    this.renderProfile = null;
    this.lastMusicPath = null;
    this.musicDirectory = path.resolve(options.musicDirectory || path.join(process.cwd(), 'data', 'music'));
    
    // Initialize AI services with graceful fallback
    const openaiKey = resolvedCredentials.openai?.apiKey || process.env.OPENAI_API_KEY;
    const replicateKey = resolvedCredentials.replicate?.apiKey || process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY;
    
    if (openaiKey) {
      this.openai = new OpenAI({ apiKey: openaiKey });
      this.logger.info('OpenAI service initialized');
    } else {
      this.logger.warn('OpenAI API key not found - AI features will be simulated');
    }
    
    if (replicateKey) {
      this.replicate = new Replicate({ auth: replicateKey });
      this.logger.info('Replicate service initialized');
    } else {
      this.logger.warn('Replicate API key not found - advanced video generation unavailable');
    }

    // Gemini media generation (images + native TTS) — free-tier alternative to OpenAI
    const geminiKey = resolvedCredentials.gemini?.apiKey || process.env.GEMINI_API_KEY;
    if (geminiKey) {
      try {
        const { GoogleGenAI } = require('@google/genai');
        this.gemini = new GoogleGenAI({ apiKey: geminiKey });
        this.logger.info('Gemini media service initialized (images + TTS)');
      } catch (error) {
        this.logger.warn('Failed to initialize Gemini media service:', error.message);
      }
    }
    
    // ElevenLabs configuration
    this.elevenLabsApiKey = resolvedCredentials.elevenLabs?.apiKey || process.env.ELEVENLABS_API_KEY;
    this.elevenLabsVoiceId = resolvedCredentials.elevenLabs?.voiceId || process.env.ELEVENLABS_VOICE_ID;
    this.elevenLabsModel = process.env.ELEVENLABS_TTS_MODEL || 'eleven_v3';
    
    // Azure Speech configuration
    this.azureSpeechKey = resolvedCredentials.azure?.speechKey || process.env.AZURE_SPEECH_KEY;
    this.azureSpeechRegion = resolvedCredentials.azure?.speechRegion || process.env.AZURE_SPEECH_REGION;
    this.mediaGeneration = options.mediaGeneration || (this.db
      ? new MediaGenerationService(this.db, resolvedCredentials, { logger: this.logger })
      : null);
  }

  async generateTTSAudio(text, outputPath) {
    this.logger.info('Generating TTS audio...');
    this.lastNarrationResult = null;
    let provider = 'simulation';
    let model = null;

    try {
      let generatedPath;
      const requestedProvider = String(process.env.TTS_PROVIDER || 'local_os').toLowerCase();
      const selectedProvider = requestedProvider === 'auto'
        ? (this.elevenLabsApiKey && this.elevenLabsVoiceId ? 'elevenlabs' : this.openai ? 'openai' : this.gemini ? 'gemini' : 'local_os')
        : requestedProvider;

      if (selectedProvider === 'elevenlabs') {
        if (!this.elevenLabsApiKey || !this.elevenLabsVoiceId) throw new Error('TTS_PROVIDER=elevenlabs requires ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID');
        provider = 'elevenlabs';
        model = this.elevenLabsModel;
        generatedPath = await this.generateElevenLabsTTS(text, outputPath);
      } else if (selectedProvider === 'openai') {
        if (!this.openai) throw new Error('TTS_PROVIDER=openai requires OPENAI_API_KEY');
        provider = 'openai';
        model = 'gpt-4o-mini-tts';
        generatedPath = await this.generateOpenAITTS(text, outputPath);
      } else if (selectedProvider === 'gemini') {
        if (!this.gemini) throw new Error('TTS_PROVIDER=gemini requires GEMINI_API_KEY');
        provider = 'gemini';
        model = process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts';
        generatedPath = await this.generateGeminiTTS(text, outputPath);
      } else if (selectedProvider === 'local_os') {
        provider = 'local_os';
        model = this.platform === 'win32'
          ? 'Windows System.Speech'
          : this.platform === 'darwin' ? 'macOS say' : 'eSpeak';
        generatedPath = await this.generateLocalTTSAudio(text, outputPath);
      } else {
        const error = new Error(`Unsupported TTS_PROVIDER "${requestedProvider}". Use local_os, auto, openai, gemini, or elevenlabs.`);
        error.code = 'TTS_PROVIDER_UNSUPPORTED';
        throw error;
      }

      const usable = await this.isUsableAudioFile(generatedPath);
      this.lastNarrationResult = {
        status: usable ? 'ready' : 'unavailable',
        path: generatedPath,
        provider,
        model,
        externalTaskId: null,
        generatedAt: new Date().toISOString(),
        simulated: !usable,
        cost: { provider, amount: null, currency: null, invoiceRequired: !['simulation', 'local_os'].includes(provider) }
      };
      return generatedPath;
    } catch (error) {
      this.lastNarrationResult = {
        status: 'failed', path: null, provider, model, externalTaskId: null,
        generatedAt: new Date().toISOString(), simulated: false, error: error.message,
        cost: { provider, amount: null, currency: null, invoiceRequired: !['simulation', 'local_os'].includes(provider) }
      };
      this.logger.error('TTS generation failed:', error);
      throw error;
    }
  }

  async generateElevenLabsTTS(text, outputPath) {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.elevenLabsVoiceId}`;
    
    const data = {
      text: text,
      model_id: this.elevenLabsModel,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8,
        style: 0.0,
        use_speaker_boost: true
      }
    };

    const response = await axios({
      method: 'POST',
      url: url,
      data: data,
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': this.elevenLabsApiKey
      },
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        this.logger.info('ElevenLabs TTS generation complete');
        resolve(outputPath);
      });
      writer.on('error', reject);
    });
  }

  async generateOpenAITTS(text, outputPath) {
    const response = await this.openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "coral",
      input: text,
      speed: 1.0
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(outputPath, buffer);

    this.logger.info('OpenAI TTS generation complete');
    return outputPath;
  }

  async generateGeminiTTS(text, outputPath) {
    const model = process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts';
    const voiceName = process.env.GEMINI_TTS_VOICE || 'Kore';

    const response = await this.gemini.models.generateContent({
      model,
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName }
          }
        }
      }
    });

    const audioData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!audioData) {
      throw new Error('Gemini TTS returned no audio data');
    }

    // Gemini returns raw PCM (24kHz, mono, 16-bit); encode to the requested container via FFmpeg
    const pcmPath = outputPath + '.pcm';
    await fs.writeFile(pcmPath, Buffer.from(audioData, 'base64'));
    await runFFmpeg(['-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcmPath, outputPath]);
    await fs.unlink(pcmPath).catch(() => {});

    this.logger.info('Gemini TTS generation complete');
    return outputPath;
  }

  async runLocalCommand(command, args, timeoutMs = 600000) {
    return new Promise((resolve, reject) => {
      const child = this.spawn(command, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve({ stdout, stderr });
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error('Local speech synthesis exceeded its time limit'));
      }, timeoutMs);
      child.stdout?.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-3000); });
      child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-3000); });
      child.once('error', error => finish(new Error(`Could not start local speech engine (${command}): ${error.message}`)));
      child.once('close', code => {
        if (code === 0) finish();
        else finish(new Error(`Local speech engine exited with code ${code}. ${stderr || stdout || 'No diagnostic output.'}`));
      });
    });
  }

  async generateLocalTTSAudio(text, outputPath) {
    const textPath = outputPath + '.local-tts.txt';
    const wavPath = outputPath + '.local-tts.wav';
    const scriptPath = outputPath + '.local-tts.ps1';
    await fs.writeFile(textPath, String(text || ''), 'utf8');

    try {
      if (this.platform === 'win32') {
        const script = [
          'param([string]$OutputPath, [string]$TextPath)',
          "$ErrorActionPreference = 'Stop'",
          'Add-Type -AssemblyName System.Speech',
          '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
          '$synth.Rate = 0',
          '$synth.Volume = 100',
          '$male = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Gender -eq [System.Speech.Synthesis.VoiceGender]::Male } | Select-Object -First 1',
          'if ($male) { $synth.SelectVoice($male.VoiceInfo.Name) }',
          '$synth.SetOutputToWaveFile($OutputPath)',
          '$speechText = [System.IO.File]::ReadAllText($TextPath, [System.Text.Encoding]::UTF8)',
          '$synth.Speak($speechText)',
          '$synth.Dispose()'
        ].join('\n');
        await fs.writeFile(scriptPath, script, 'utf8');
        await this.runLocalCommand('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', scriptPath, '-OutputPath', wavPath, '-TextPath', textPath
        ]);
      } else if (this.platform === 'darwin') {
        await this.runLocalCommand('say', ['-o', wavPath, '--file-format=WAVE', '-f', textPath]);
      } else {
        try {
          await this.runLocalCommand('espeak-ng', ['-f', textPath, '-w', wavPath]);
        } catch (_error) {
          await this.runLocalCommand('espeak', ['-f', textPath, '-w', wavPath]);
        }
      }

      const wavStats = await fs.stat(wavPath).catch(() => null);
      if (!wavStats?.isFile() || wavStats.size < 1000) {
        throw new Error('The local speech engine did not produce a valid WAV narration file');
      }
      await this.runFFmpeg(['-y', '-i', wavPath, '-codec:a', 'libmp3lame', '-q:a', '4', outputPath]);
      const outputStats = await fs.stat(outputPath).catch(() => null);
      if (!outputStats?.isFile() || outputStats.size < 1000) {
        throw new Error('FFmpeg did not produce a valid local narration file');
      }
      this.logger.info('Local operating-system speech synthesis complete');
      return outputPath;
    } finally {
      await Promise.all([
        fs.unlink(textPath).catch(() => {}),
        fs.unlink(wavPath).catch(() => {}),
        fs.unlink(scriptPath).catch(() => {})
      ]);
    }
  }

  async generateVisualAssets(prompt, style = "ethereal", count = 1) {
    this.logger.info(`Generating ${count} visual assets with style: ${style}`);

    if (!this.openai && !this.gemini) {
      const error = new Error('No image-generation provider is configured. Add an OpenAI or Gemini image key in Settings before generating a production video.');
      error.code = 'IMAGE_PROVIDER_UNAVAILABLE';
      throw error;
    }

    try {
      const enhancedPrompt = this.enhanceVisualPrompt(prompt, style);
      const localPaths = [];

      for (let i = 0; i < count; i++) {
        const imagePath = path.join(__dirname, '..', 'data', 'assets', `visual_${Date.now()}_${i}.png`);
        await this.generateImage(enhancedPrompt, imagePath);
        localPaths.push(imagePath);
      }

      this.logger.info(`Generated ${localPaths.length} real visual assets`);
      return localPaths;
    } catch (error) {
      this.logger.error('Real visual asset generation failed; refusing placeholder assets:', error);
      throw error;
    }
  }

  async generateImage(prompt, imagePath) {
    await fs.mkdir(path.dirname(imagePath), { recursive: true });

    const providers = [];
    if (this.openai) {
      providers.push({ name: 'OpenAI', model: OPENAI_IMAGE_MODEL, run: () => this.generateOpenAIImage(prompt, imagePath) });
    }
    if (this.gemini) {
      providers.push({ name: 'Gemini', model: this.geminiImageModel(), run: () => this.generateGeminiImage(prompt, imagePath) });
    }
    if (!providers.length) {
      throw new Error('No image generation provider configured');
    }

    // Try every configured provider before giving up, so a broken OpenAI key
    // does not hide a working Gemini key (or the reverse).
    const failures = [];
    for (const [index, provider] of providers.entries()) {
      try {
        return await provider.run();
      } catch (error) {
        const description = describeImageProviderError(provider.name, provider.model, error);
        failures.push(description);
        if (index < providers.length - 1) {
          this.logger.warn(`${description} Trying ${providers[index + 1].name} instead.`);
        }
      }
    }

    const error = new Error(failures.join(' | '));
    error.providerFailures = failures;
    throw error;
  }

  geminiImageModel() {
    return process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
  }

  async generateOpenAIImage(prompt, imagePath) {
    const response = await this.openai.images.generate({
      model: OPENAI_IMAGE_MODEL,
      prompt: prompt,
      n: 1,
      size: "1536x1024",
      quality: "high",
    });

    if (response.data[0].b64_json) {
      const buffer = Buffer.from(response.data[0].b64_json, 'base64');
      await fs.writeFile(imagePath, buffer);
    } else {
      await this.downloadImage(response.data[0].url, imagePath);
    }

    return imagePath;
  }

  async generateGeminiImage(prompt, imagePath) {
    const model = this.geminiImageModel();

    const response = await this.gemini.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseModalities: ['IMAGE'],
        imageConfig: {
          aspectRatio: '16:9',
          imageSize: '1K'
        }
      }
    });

    const parts = response.candidates?.[0]?.content?.parts || [];
    const imageParts = parts.filter(part =>
      part.inlineData?.data && (!part.inlineData.mimeType || part.inlineData.mimeType.startsWith('image/'))
    );
    const renderedImages = imageParts.filter(part => part.thought !== true);
    const imagePart = (renderedImages.length ? renderedImages : imageParts).at(-1);
    if (!imagePart) {
      throw new Error('Gemini image generation returned no image data');
    }

    const imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
    const metadata = await sharp(imageBuffer, { failOn: 'error' }).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error('Gemini image generation returned an invalid image asset');
    }

    const extension = path.extname(imagePath).toLowerCase();
    const output = sharp(imageBuffer, { failOn: 'error' });
    if (extension === '.jpg' || extension === '.jpeg') {
      await output.jpeg({ quality: 92 }).toFile(imagePath);
    } else if (extension === '.webp') {
      await output.webp({ quality: 92 }).toFile(imagePath);
    } else {
      await output.png().toFile(imagePath);
    }
    return imagePath;
  }

  enhanceVisualPrompt(prompt, style) {
    const styleEnhancements = {
      ethereal: "ethereal, dreamy, mystical, soft lighting, floating particles, cosmic background",
      modern: "modern, clean, minimalist, professional, sleek design, contemporary",
      animated: "animated style, cartoon, vibrant colors, expressive, dynamic",
      cinematic: "cinematic lighting, dramatic, movie poster style, high contrast",
      abstract: "abstract art, geometric shapes, gradient colors, artistic composition"
    };

    const normalizedStyle = String(style || '').trim().toLowerCase();
    const enhancement = styleEnhancements[normalizedStyle] || String(style || '').trim() || styleEnhancements.ethereal;
    return `${prompt}, ${enhancement}, high quality, 16:9 aspect ratio, digital art`;
  }

  async downloadImage(url, outputPath) {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  async generateVideo(script, visualAssets, audioPath, outputPath, options = {}) {
    this.logger.info('Generating video from real media assets...');
    this.lastVideoResult = null;
    this.lastMusicPath = null;

    try {
      if (!this.mediaGeneration || !options.productionId) {
        const error = new Error('The production video pipeline is not initialized. A persisted production and media-generation service are required; refusing to create a slideshow or simulated substitute.');
        error.code = 'VIDEO_PIPELINE_NOT_CONFIGURED';
        throw error;
      }

      const generated = await this.mediaGeneration.generateClips({
        jobId: options.jobId || null,
        productionId: options.productionId,
        script,
        visualAssets,
        outputDir: path.dirname(outputPath)
      });

      // Slideshow is supported only when the operator explicitly selected it.
      if (generated.actualProvider === 'slideshow') {
        const produced = await this.generateSlideshowVideo(script, visualAssets, audioPath, outputPath);
        this.lastVideoResult = {
          requestedProvider: generated.requestedProvider, actualProvider: 'slideshow',
          model: 'local-ffmpeg', mode: 'slideshow', generatedSeconds: 0, tasks: [], scenes: []
        };
        return produced;
      }

      if (!generated.clips?.length) {
        const error = new Error('The selected AI video provider returned no usable moving clips. Production has been stopped instead of silently creating a slideshow.');
        error.code = 'AI_VIDEO_CLIPS_REQUIRED';
        throw error;
      }

      const produced = await this.generateHybridVideo(
        generated.clips,
        visualAssets,
        audioPath,
        outputPath,
        options.estimatedDuration || this.calculateScriptDuration(script)
      );
      this.lastVideoResult = {
        requestedProvider: generated.requestedProvider,
        actualProvider: generated.actualProvider,
        model: generated.model,
        mode: generated.settings.mode,
        generatedSeconds: generated.clips.reduce((total, clip) => total + clip.duration, 0),
        tasks: generated.clips.map(clip => ({ scene: clip.index, taskId: clip.taskId, provider: clip.provider, model: clip.model })),
        scenes: generated.clips.map(clip => ({
          index: clip.index, label: clip.label, prompt: clip.prompt, duration: clip.duration,
          path: clip.path, taskId: clip.taskId, provider: clip.provider, model: clip.model,
          source: clip.source || null
        })),
        sources: generated.clips.map(clip => clip.source).filter(Boolean)
      };
      return produced;
    } catch (error) {
      const reason = error && error.message ? error.message : String(error);
      this.logger.error(`AI video generation failed; no slideshow or simulated fallback will be marked as success: ${reason}`, error);

      if (options.allowSlideshowFallback === true) {
        this.logger.warn('An explicit allowSlideshowFallback option was supplied; attempting the requested slideshow fallback.');
        try {
          const produced = await this.generateSlideshowVideo(script, visualAssets, audioPath, outputPath);
          this.lastVideoResult = {
            requestedProvider: 'configured-provider', actualProvider: 'slideshow',
            model: 'local-ffmpeg', mode: 'explicit-fallback', generatedSeconds: 0,
            fallbackReason: reason, tasks: [], scenes: []
          };
          return produced;
        } catch (fallbackError) {
          fallbackError.message = `AI video generation failed: ${reason}. Explicit slideshow fallback also failed: ${fallbackError.message}`;
          throw fallbackError;
        }
      }

      throw error;
    }
  }

  async generateHybridVideo(clips, visualAssets, audioPath, outputPath, totalDuration) {
    if (!(await checkFFmpeg())) throw new Error(ffmpegInstallHint());
    const validImages = await this.filterLocalImageAssets(visualAssets);
    const segments = clips.map(clip => ({ type: 'video', path: clip.path, duration: clip.duration }));
    const generatedDuration = segments.reduce((sum, item) => sum + item.duration, 0);
    const remaining = Math.max(0, this.parseDurationSeconds(totalDuration) - generatedDuration);
    if (remaining && validImages.length) {
      const perImage = Math.max(2, remaining / validImages.length);
      for (const imagePath of validImages) segments.push({ type: 'image', path: imagePath, duration: perImage });
    }
    if (!segments.length) throw new Error('No usable provider clips or still images were generated');

    const visualPath = outputPath.replace(/\.mp4$/i, '_hybrid_visual.mp4');
    await this.renderMediaTimeline(segments, visualPath);
    const musicPath = await this.findBackgroundMusic();
    this.lastMusicPath = musicPath;
    await this.addAudioToVideo(visualPath, audioPath, outputPath, { loopVideo: true, musicPath });
    await fs.unlink(visualPath).catch(() => {});
    return outputPath;
  }

  async getRenderProfile() {
    if (this.renderProfile) return this.renderProfile;
    let hardware = this.hardwareProfile;
    if (!hardware) {
      try {
        const { detectHardwareProfile } = require('./hardware-profile');
        hardware = await detectHardwareProfile();
      } catch (_error) {
        hardware = { profile: 'integrated' };
      }
      this.hardwareProfile = hardware;
    }
    const profile = hardware?.profile || 'integrated';
    const defaultWidth = profile === 'high_gpu' ? 1920 : profile === 'integrated' ? 960 : 1280;
    const width = Math.max(640, Math.min(3840, Number(process.env.VIDEO_OUTPUT_WIDTH || defaultWidth)));
    const height = Math.max(360, Math.min(2160, Number(process.env.VIDEO_OUTPUT_HEIGHT || Math.round(width * 9 / 16))));
    this.renderProfile = { width, height, fps: 24, hardwareProfile: profile };
    return this.renderProfile;
  }

  async findBackgroundMusic() {
    const directory = this.musicDirectory;
    const extensions = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);
    const files = await fs.readdir(directory).catch(() => []);
    const selected = files
      .filter(name => extensions.has(path.extname(name).toLowerCase()))
      .sort()[0];
    return selected ? path.join(directory, selected) : null;
  }

  async renderMediaTimeline(segments, outputPath) {
    if (!segments.length) throw new Error('A media timeline requires at least one segment');
    const profile = await this.getRenderProfile();
    const args = ['-y'];
    for (const segment of segments) {
      const duration = Number(segment.duration).toFixed(2);
      if (segment.type === 'image') args.push('-loop', '1', '-t', duration, '-framerate', String(profile.fps), '-i', segment.path);
      else args.push('-stream_loop', '-1', '-t', duration, '-i', segment.path);
    }

    const filters = segments.map((segment, index) => {
      const duration = Number(segment.duration).toFixed(2);
      return `[${index}:v]scale=${profile.width}:${profile.height}:force_original_aspect_ratio=increase,crop=${profile.width}:${profile.height},fps=${profile.fps},format=yuv420p,trim=duration=${duration},setpts=PTS-STARTPTS[v${index}]`;
    });

    const transition = 0.35;
    if (segments.length === 1) {
      filters.push('[v0]null[vout]');
    } else {
      let previous = 'v0';
      let elapsed = Number(segments[0].duration);
      for (let index = 1; index < segments.length; index++) {
        const output = index === segments.length - 1 ? 'vout' : `vx${index}`;
        const fadeDuration = Math.min(transition, Number(segments[index - 1].duration) / 3, Number(segments[index].duration) / 3);
        const offset = Math.max(0, elapsed - fadeDuration);
        filters.push(`[${previous}][v${index}]xfade=transition=fade:duration=${fadeDuration.toFixed(2)}:offset=${offset.toFixed(2)}[${output}]`);
        previous = output;
        elapsed += Number(segments[index].duration) - fadeDuration;
      }
    }
    args.push(
      '-filter_complex', filters.join(';'),
      '-map', '[vout]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '25',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputPath
    );
    await this.runFFmpeg(args);
    return outputPath;
  }

  async filterLocalImageAssets(visualAssets = []) {
    const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
    const images = [];
    for (const asset of visualAssets) {
      if (typeof asset !== 'string' || !imageExtensions.has(path.extname(asset).toLowerCase())) continue;
      try {
        await fs.access(asset);
        images.push(asset);
      } catch (_error) { /* ignore missing assets */ }
    }
    return images;
  }

  parseDurationSeconds(value) {
    if (Number.isFinite(Number(value))) return Math.max(0, Number(value));
    const parts = String(value || '').split(':').map(Number);
    if (parts.length === 2 && parts.every(Number.isFinite)) return Math.max(0, parts[0] * 60 + parts[1]);
    if (parts.length === 3 && parts.every(Number.isFinite)) return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
    return 0;
  }

  async generateReplicateVideo(script, visualAssets, audioPath, outputPath) {
    const output = await this.replicate.run(
      "wan-video/wan-2.7-i2v",
      {
        input: {
          image: visualAssets[0],
          prompt: script.title || "smooth cinematic motion",
          duration: 5,
          resolution: "720p"
        }
      }
    );

    // Download the generated video
    if (output && output.length > 0) {
      await this.downloadVideo(output[0], outputPath);
      
      // Add narration and optional locally licensed background music.
      const musicPath = await this.findBackgroundMusic();
      this.lastMusicPath = musicPath;
      await this.addAudioToVideo(outputPath, audioPath, outputPath, { musicPath });
    }

    return outputPath;
  }

  async generateSlideshowVideo(script, visualAssets, audioPath, outputPath) {
    this.logger.info('Creating slideshow video...');

    if (!(await checkFFmpeg())) {
      throw new Error(ffmpegInstallHint());
    }

    const { chromium } = require('playwright');
    const browser = await chromium.launch();
    const slidesDir = path.join(path.dirname(outputPath), 'slides');

    try {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 1920, height: 1080 });

      // Create HTML for slideshow (only real image files can be embedded)
      const imageAssets = await this.filterImageAssets(visualAssets);
      await page.setContent(this.createSlideshowHTML(script, imageAssets));

      // Freeze CSS transitions/animations so each still is captured fully rendered
      await page.addStyleTag({ content: '* { transition: none !important; animation: none !important; }' });
      await page.waitForTimeout(1000); // Wait for assets to load

      // Capture ONE still per slide instead of screenshotting at 30fps —
      // FFmpeg turns the stills into a crossfaded video in seconds.
      const slideCount = await page.evaluate(() => document.querySelectorAll('.slide').length);
      await fs.mkdir(slidesDir, { recursive: true });

      const stills = [];
      for (let i = 0; i < slideCount; i++) {
        await page.evaluate((index) => {
          document.querySelectorAll('.slide').forEach((slide, s) => {
            slide.classList.toggle('active', s === index);
          });
        }, i);

        const stillPath = path.join(slidesDir, `slide_${String(i).padStart(3, '0')}.png`);
        await page.screenshot({ path: stillPath });
        stills.push(stillPath);
      }

      const videoPath = outputPath.replace('.mp4', '_visual.mp4');
      const duration = await this.resolveSlideshowDuration(script, audioPath);
      await this.renderSlidesToVideo(stills, duration, videoPath);

      // Add narration and optional locally licensed background music.
      const musicPath = await this.findBackgroundMusic();
      this.lastMusicPath = musicPath;
      await this.addAudioToVideo(videoPath, audioPath, outputPath, { musicPath });

      return outputPath;
    } finally {
      await browser.close().catch(() => {});
      await this.cleanupDirectory(slidesDir);
    }
  }

  async resolveSlideshowDuration(script, audioPath) {
    try {
      return (await this.getMediaDuration(audioPath)) + 0.5;
    } catch (error) {
      this.logger.warn(`Could not read narration duration, falling back to word-count estimate: ${error.message}`);
      return this.calculateScriptDuration(script);
    }
  }

  async renderSlidesToVideo(stills, totalDuration, videoPath) {
    if (stills.length === 0) {
      throw new Error('No slides to render');
    }

    const fade = 0.5;
    const overlapDuration = fade * Math.max(0, stills.length - 1);
    const perSlide = Math.max(2, (totalDuration + overlapDuration) / stills.length);

    const args = ['-y'];
    for (const still of stills) {
      args.push('-loop', '1', '-t', perSlide.toFixed(2), '-framerate', '30', '-i', still);
    }

    if (stills.length === 1) {
      args.push('-vf', 'format=yuv420p', '-c:v', 'libx264', videoPath);
      await runFFmpeg(args);
      return videoPath;
    }

    // Chain crossfades: transition k starts fade seconds before slide k ends
    const filters = [];
    let prev = '[0:v]';
    for (let i = 1; i < stills.length; i++) {
      const out = `[v${i}]`;
      const offset = (i * (perSlide - fade)).toFixed(2);
      filters.push(`${prev}[${i}:v]xfade=transition=fade:duration=${fade}:offset=${offset}${out}`);
      prev = out;
    }
    filters.push(`${prev}format=yuv420p[vfinal]`);

    args.push(
      '-filter_complex', filters.join(';'),
      '-map', '[vfinal]',
      '-c:v', 'libx264',
      '-r', '30',
      videoPath
    );

    await runFFmpeg(args);
    return videoPath;
  }

  async filterImageAssets(visualAssets = []) {
    const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
    const mimeTypes = {
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp'
    };
    const images = [];

    for (const asset of visualAssets) {
      if (typeof asset !== 'string' || !imageExtensions.has(path.extname(asset).toLowerCase())) {
        continue;
      }

      try {
        const imageBuffer = await fs.readFile(asset);
        const metadata = await sharp(imageBuffer, { failOn: 'error' }).metadata();
        const mimeType = mimeTypes[metadata.format];
        if (mimeType && metadata.width && metadata.height) {
          images.push(`data:${mimeType};base64,${imageBuffer.toString('base64')}`);
        }
      } catch (_error) {
        // Skip missing or invalid image files
      }
    }

    return images;
  }

  createSlideshowHTML(script, visualAssets) {
    return `
<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            margin: 0;
            padding: 0;
            width: 1920px;
            height: 1080px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            font-family: 'Arial', sans-serif;
            overflow: hidden;
        }
        
        .slide {
            position: absolute;
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transition: opacity 2s ease-in-out;
        }
        
        .slide.active {
            opacity: 1;
        }
        
        .content {
            position: relative;
            z-index: 2;
            text-align: center;
            color: white;
            max-width: 80%;
        }
        
        h1 {
            font-size: 72px;
            margin-bottom: 30px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
        }
        
        h2 {
            font-size: 48px;
            margin-bottom: 20px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
        }
        
        p {
            font-size: 36px;
            line-height: 1.4;
            text-shadow: 1px 1px 2px rgba(0,0,0,0.5);
        }
        
        .background-image {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            object-fit: cover;
            z-index: 0;
        }

        /* Darkens the image just enough to keep the slide text readable */
        .scrim {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.6) 100%);
            z-index: 1;
        }

        .particles {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            z-index: -1;
        }
        
        .particle {
            position: absolute;
            background: rgba(255,255,255,0.8);
            border-radius: 50%;
            animation: float 6s ease-in-out infinite;
        }
        
        @keyframes float {
            0%, 100% { transform: translateY(0px); }
            50% { transform: translateY(-20px); }
        }
    </style>
</head>
<body>
    <div class="particles"></div>
    
    <!-- Title Slide -->
    <div class="slide active">
        ${visualAssets[0] ? `<img class="background-image" src="${visualAssets[0]}" /><div class="scrim"></div>` : ''}
        <div class="content">
            <h1>${script.title}</h1>
        </div>
    </div>

    ${this.generateContentSlides(script, visualAssets).join('')}

    <!-- Subscribe Slide -->
    <div class="slide">
        <div class="content">
            <h2>Thanks for watching</h2>
            <p>Subscribe for more videos like this</p>
        </div>
    </div>
    
    <script>
        // Create floating particles
        function createParticles() {
            const container = document.querySelector('.particles');
            for (let i = 0; i < 20; i++) {
                const particle = document.createElement('div');
                particle.className = 'particle';
                particle.style.left = Math.random() * 100 + '%';
                particle.style.top = Math.random() * 100 + '%';
                particle.style.width = (Math.random() * 4 + 2) + 'px';
                particle.style.height = particle.style.width;
                particle.style.animationDelay = Math.random() * 6 + 's';
                container.appendChild(particle);
            }
        }
        
        let currentSlide = 0;
        const slides = document.querySelectorAll('.slide');
        
        function advanceAnimation() {
            slides[currentSlide].classList.remove('active');
            currentSlide = (currentSlide + 1) % slides.length;
            slides[currentSlide].classList.add('active');
        }
        
        window.advanceAnimation = advanceAnimation;
        createParticles();
    </script>
</body>
</html>`;
  }

  generateContentSlides(script, visualAssets) {
    const slides = [];
    
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach((section, index) => {
        const assetIndex = Math.min(index + 1, visualAssets.length - 1);
        
        slides.push(`
        <div class="slide">
            ${visualAssets[assetIndex] ? `<img class="background-image" src="${visualAssets[assetIndex]}" /><div class="scrim"></div>` : ''}
            <div class="content">
                <h2>${section.title}</h2>
                ${this.formatSectionContent(section)}
            </div>
        </div>`);
      });
    }
    
    return slides;
  }

  formatSectionContent(section) {
    if (section.items && Array.isArray(section.items)) {
      return section.items.slice(0, 3).map(item => 
        `<p>${item.number}. ${item.title}</p>`
      ).join('');
    }
    
    if (section.steps && Array.isArray(section.steps)) {
      return section.steps.slice(0, 3).map(step => 
        `<p>${step.title}</p>`
      ).join('');
    }
    
    // Script writers store spoken lines as an array of strings
    if (Array.isArray(section.content)) {
      return section.content
        .filter(line => typeof line === 'string' && line.trim())
        .slice(0, 3)
        .map(line => `<p>${line.slice(0, 120)}${line.length > 120 ? '...' : ''}</p>`)
        .join('');
    }

    if (typeof section.content === 'string') {
      return `<p>${section.content.slice(0, 200)}${section.content.length > 200 ? '...' : ''}</p>`;
    }

    return '';
  }

  calculateScriptDuration(script) {
    // Estimate duration based on word count (average 150 words per minute)
    let totalWords = 0;
    
    if (script.hook) totalWords += script.hook.text.split(' ').length;
    if (script.introduction) {
      totalWords += (script.introduction.greeting || '').split(' ').length;
      totalWords += (script.introduction.topicIntro || '').split(' ').length;
    }
    
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach(section => {
        if (typeof section.content === 'string') {
          totalWords += section.content.split(' ').length;
        }
        if (section.items) {
          section.items.forEach(item => {
            totalWords += (item.title + ' ' + item.description).split(' ').length;
          });
        }
        if (section.steps) {
          section.steps.forEach(step => {
            totalWords += (step.title + ' ' + step.description).split(' ').length;
          });
        }
      });
    }
    
    if (script.conclusion) {
      totalWords += script.conclusion.finalThought.split(' ').length;
    }
    
    // Convert to duration (150 words per minute)
    return Math.max(30, Math.ceil((totalWords / 150) * 60));
  }

  async addAudioToVideo(videoPath, audioPath, outputPath, options = {}) {
    const hasRealAudio = await this.isUsableAudioFile(audioPath);

    if (!hasRealAudio) {
      if (options.allowSilent === true) {
        this.logger.warn('Creating an intentionally silent video from an operator-confirmed override.');
        if (videoPath !== outputPath) await fs.copyFile(videoPath, outputPath);
        return outputPath;
      }
      const error = new Error('Narration audio is required. Regenerate narration or explicitly confirm an intentional silent video.');
      error.code = 'NARRATION_REQUIRED';
      throw error;
    }

    const muxPath = outputPath === videoPath
      ? outputPath.replace(/\.mp4$/i, '_muxed.mp4')
      : outputPath;
    const videoInput = options.loopVideo ? ['-stream_loop', '-1', '-i', videoPath] : ['-i', videoPath];
    const musicPath = options.musicPath && await this.isUsableAudioFile(options.musicPath) ? options.musicPath : null;

    if (musicPath) {
      await this.runFFmpeg([
        '-y', ...videoInput,
        '-i', audioPath,
        '-stream_loop', '-1', '-i', musicPath,
        '-filter_complex',
        '[1:a]volume=1.0[narration];[2:a]volume=0.12[music];[narration][music]amix=inputs=2:duration=first:dropout_transition=2[aout]',
        '-map', '0:v:0', '-map', '[aout]',
        '-c:v', 'copy', '-c:a', 'aac', '-shortest', muxPath
      ]);
    } else {
      await this.runFFmpeg([
        '-y', ...videoInput, '-i', audioPath,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy', '-c:a', 'aac', '-shortest', muxPath
      ]);
    }

    if (muxPath !== outputPath) await fs.rename(muxPath, outputPath);
    this.logger.info(musicPath ? 'Narration and background music mixed successfully' : 'Narration added to video successfully');
    return outputPath;
  }

  async isUsableAudioFile(audioPath) {
    if (typeof audioPath !== 'string' || audioPath.endsWith('.info')) {
      return false;
    }

    try {
      const stats = await fs.stat(audioPath);
      return stats.isFile() && stats.size > 0;
    } catch (error) {
      return false;
    }
  }

  async downloadVideo(url, outputPath) {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  async cleanupDirectory(dirPath) {
    try {
      const files = await fs.readdir(dirPath);
      for (const file of files) {
        await fs.unlink(path.join(dirPath, file));
      }
      await fs.rmdir(dirPath);
    } catch (error) {
      this.logger.warn('Cleanup failed:', error.message);
    }
  }

  async generateThumbnail(script, style = "ethereal") {
    this.logger.info('Generating custom thumbnail...');

    try {
      if (!this.openai && !this.gemini) {
        return await this.simulateThumbnailGeneration(script, style);
      }

      const prompt = `YouTube thumbnail for "${script.title}", ${style} style, eye-catching, high contrast text, professional design, clickable, engaging`;
      const thumbnailPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_${Date.now()}.png`);

      await this.generateImage(prompt, thumbnailPath);
      const metadata = await sharp(thumbnailPath).metadata();

      return {
        path: thumbnailPath,
        dimensions: { width: metadata.width, height: metadata.height },
        fileSize: await this.getFileSize(thumbnailPath)
      };
    } catch (error) {
      this.logger.error('Thumbnail generation failed:', error);
      return await this.simulateThumbnailGeneration(script, style);
    }
  }

  async getFileSize(filePath) {
    const stats = await fs.stat(filePath);
    return stats.size;
  }

  // Simulation methods for when APIs are not available
  async simulateTTSGeneration(text, outputPath) {
    this.logger.info('Simulating TTS generation...');
    
    const infoPath = outputPath + '.info';
    await fs.writeFile(infoPath, JSON.stringify({
      message: 'AI TTS audio would be generated here',
      text: text.substring(0, 100) + '...',
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return infoPath;
  }

  async simulateVisualAssets(prompt, style, count) {
    this.logger.info(`Simulating ${count} visual assets...`);
    
    const paths = [];
    for (let i = 0; i < count; i++) {
      const assetPath = path.join(__dirname, '..', 'data', 'assets', `visual_sim_${Date.now()}_${i}.info`);
      
      await fs.writeFile(assetPath, JSON.stringify({
        message: 'AI visual asset would be generated here',
        prompt: prompt,
        style: style,
        timestamp: new Date().toISOString()
      }, null, 2));
      
      paths.push(assetPath);
    }
    
    return paths;
  }

  async simulateVideoGeneration(script, visualAssets, audioPath, outputPath) {
    this.logger.info('Simulating video generation...');
    
    const infoPath = outputPath + '.info';
    await fs.writeFile(infoPath, JSON.stringify({
      message: 'AI video would be generated here',
      script: script.title,
      visualAssets: visualAssets.length,
      audioPath: audioPath,
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return infoPath;
  }

  async simulateThumbnailGeneration(script, style) {
    this.logger.info('Simulating thumbnail generation...');
    
    const thumbnailPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_sim_${Date.now()}.info`);
    await fs.mkdir(path.dirname(thumbnailPath), { recursive: true });
    
    await fs.writeFile(thumbnailPath, JSON.stringify({
      message: 'AI thumbnail would be generated here',
      title: script.title,
      style: style,
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return {
      path: thumbnailPath,
      dimensions: { width: 1792, height: 1024 },
      fileSize: 1024,
      simulated: true
    };
  }
}

module.exports = { AIVideoGenerator, describeImageProviderError };
