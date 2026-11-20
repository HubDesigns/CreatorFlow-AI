# AI providers

YouTube Automation Agent runs on your own API keys. One text provider is enough to start. Narration, images, and AI video are optional layers on top. Pick providers in `npm run walkthrough`, or set their keys in `.env` ([`.env.example`](../.env.example) documents every setting).

## Text

Pick one in the walkthrough, or set its key in `.env`. The SDK base URL is configured for you.

| Provider | Models | Key | Env var |
| --- | --- | --- | --- |
| **Google Gemini** | Gemini 3.8 Flash, Gemini 4 Argon (paid only), 3.5 Flash-Lite | [AI Studio](https://aistudio.google.com/apikey) | `GEMINI_API_KEY` |
| **OpenAI** | GPT-6.1 Sol, GPT-6 Astra, GPT-6 Luna | [platform.openai.com](https://platform.openai.com/api-keys) | `OPENAI_API_KEY` |
| **OpenRouter** | 400+ models through one key; curated defaults are checked against its live catalog | [openrouter.ai](https://openrouter.ai/keys) | `OPENROUTER_API_KEY` |
| **Kimi (Moonshot AI)** | Kimi K3, K2.7 Code, K2.6 | [platform.kimi.ai](https://platform.kimi.ai) | `MOONSHOT_API_KEY` |
| **MiMo (Xiaomi)** | MiMo V2.6 Pro, V2.6 Flash | [mimo.mi.com](https://mimo.mi.com) | `MIMO_API_KEY` |
| **GLM (Zhipu AI)** | GLM-5.3, 5.3 Flash, 5.2 | [z.ai](https://z.ai) | `GLM_API_KEY` |
| **DeepSeek** | DeepSeek V4.1 Flash, V4 Pro | [platform.deepseek.com](https://platform.deepseek.com/api_keys) | `DEEPSEEK_API_KEY` |
| **MiniMax** | MiniMax M3.1 Flash, M3 | [platform.minimax.io](https://platform.minimax.io/user-center/basic-information/interface-key) | `MINIMAX_TEXT_API_KEY` |

Anthropic Claude is available through OpenRouter (`anthropic/claude-fable-5.1`). OpenRouter, Kimi, MiMo, GLM, DeepSeek, and MiniMax cover scripts only. Add a Gemini or OpenAI key for images and narration, or ElevenLabs for narration.

## Narration and images

- **Narration** defaults to Windows System.Speech, macOS `say`, or Linux eSpeak when installed, so it can work offline without an API key. Cloud voices (ElevenLabs, OpenAI, Gemini) are used only when `TTS_PROVIDER` is explicitly set to that provider or to `auto`. A video without working narration can't be approved.
- **Images** are optional for footage-first production. Topic-matched local photos can be placed in `data/images`; cloud AI image generation remains an optional workflow for reference visuals and thumbnails.

## Video

Automatic routing is footage-first. The standard path selects relevant moving clips from the local `data/footage` library, optional photos from `data/images`, local narration, optional music, and FFmpeg rendering. It works without an NVIDIA GPU or paid AI video API. When no local clip matches, it can search Pixabay if `PIXABAY_API_KEY` is configured; otherwise it stops with a clear missing-footage error.

| Provider | Default model | Best fit | Clip limits | Env var |
| --- | --- | --- | --- | --- |
| Local footage-first | `Local footage + FFmpeg` | Any PC; local video library or optional free Pixabay API key | 1–120 seconds per clip | `FOOTAGE_LIBRARY_DIR`, `PIXABAY_API_KEY` |
| Lightricks (optional local AI) | `LTX-Video 2B Q8` | Experimental local text-to-video on supported NVIDIA/CUDA systems; separate Python/CUDA runtime required | Up to 5 seconds per clip in CreatorFlow | `LTX_VIDEO_HOME`, `LTX_CHECKPOINT_DIR`, `LTX_UNET_PATH` |
| ByteDance | `bytedance/seedance-2.5` through Replicate | Cinematic long scenes and large reference sets | 4–30 seconds | `REPLICATE_API_TOKEN` |
| MiniMax | `MiniMax-H3` | Multimodal references, native stereo audio, optional 2K | 4–15 seconds | `MINIMAX_API_KEY` |
| Google | `gemini-omni-1.1-flash` | Fast generation and conversational editing | 3–10 seconds | `GEMINI_API_KEY` |
| Kuaishou | `kling-v3-omni` | Storyboards and character/voice consistency | 3–15 seconds | `KLING_ACCESS_KEY`, `KLING_SECRET_KEY` |
| Alibaba | Wan 2.7 task-specific models | Efficient generation, reference video, and continuation | 2–15 seconds | `DASHSCOPE_API_KEY` |

Long videos use hybrid assembly: real moving clips for the hook and key sections, with relevant local photos filling remaining timeline sections. Scene transitions, narration, and optional background music are rendered locally. See [footage-first setup](footage-first-video.md) and [AI video generation](features.md#ai-video-generation).

## Environment variables

`npm run walkthrough` writes your configuration for you. To edit it by hand, copy [`.env.example`](../.env.example) to `.env`. The essentials:

```env
# One text provider (see the table above)
GEMINI_API_KEY=...

# Optional: narration, images, and AI video
# ELEVENLABS_API_KEY=...
# ELEVENLABS_VOICE_ID=...
# OPENAI_API_KEY=sk-...
VIDEO_PROVIDER=auto          # footage_first, local_ltx, slideshow, seedance, minimax_h3, google_omni, kling, wan
# VIDEO_PROVIDER_ORDER=footage_first,local_ltx,seedance,minimax_h3,google_omni,kling,wan
# PIXABAY_API_KEY=...         # optional free stock-video search; local footage works without it
VIDEO_ALLOW_PAID_PROVIDERS=false  # automatic routing stays local unless explicitly enabled
# VIDEO_MAX_GENERATED_SECONDS=20

# App
PORT=3456
# HOST=127.0.0.1             # default: this machine only
# API_KEY=some-long-random-string
CHANNEL_NAME=Your Channel Name
DEFAULT_PRIVACY_STATUS=private
```

For local footage, photos, music, Pixabay caching, and offline narration, see [footage-first setup](footage-first-video.md). For optional CUDA model installation, see [Free local LTX-Video Q8](local-ltx-video.md). The dashboard listens on `127.0.0.1` by default. If you set `HOST=0.0.0.0` to reach it from other devices, also set `API_KEY`, which every request that changes something must then send in the `x-api-key` header.

## Adding a provider

See [Extending](../CONTRIBUTING.md#extending) in the contributing guide for how to add a text or video provider.

## Acknowledgments

- [Google](https://ai.google.dev/): Gemini 3.8 Flash, Gemini 4 Argon, Gemini 3.1 Flash Image, Gemini 3.8 Flash TTS, Gemini Omni Flash, and the YouTube Data and Analytics APIs
- [OpenAI](https://openai.com/): GPT-6.1 Sol, GPT Image 2, gpt-4o-mini-tts
- [OpenRouter](https://openrouter.ai/): unified multi-model API
- [Moonshot AI](https://www.moonshot.ai/): Kimi K3
- [Xiaomi](https://mimo.mi.com/): MiMo V2.6 Pro
- [Zhipu AI](https://z.ai/): GLM-5.3
- [DeepSeek](https://www.deepseek.com/): DeepSeek V4.1 Flash
- [MiniMax](https://www.minimax.io/): MiniMax M3 text and H3 video
- [ElevenLabs](https://elevenlabs.io/): Eleven v3 TTS
- [Replicate](https://replicate.com/): Seedance 2.5 and Wan 2.7 hosting
- [Kuaishou Kling](https://kling.ai/): Kling 3.0 Omni
- [Alibaba Cloud Model Studio](https://modelstudio.console.alibabacloud.com/): Wan 2.7
