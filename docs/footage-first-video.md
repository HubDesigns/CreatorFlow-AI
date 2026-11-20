# Footage-first video generation

CreatorFlow's standard video path uses real moving footage and local FFmpeg rendering. It does not require an NVIDIA GPU, a local diffusion model, or a paid video-generation API.

## 1. Local footage library (works offline)

Put video files you own or are licensed to use inside:

```text
data/footage/
```

Subfolders are supported. Supported formats are MP4, MOV, M4V, MKV, and WebM.

Use descriptive filenames so CreatorFlow can find relevant footage for each scene. For example:

- `technology-ai-computer-work.mp4`
- `nature-mountains-river.mp4`
- `business-team-meeting.mp4`
- `cooking-vegetables-kitchen.mp4`

The local matcher uses words from the scene prompt and filename. It will not silently substitute unrelated footage. If it cannot find a matching clip, the scene fails with `FOOTAGE_NOT_FOUND` and explains how to add media.

Use footage only when you have the rights to use it. Keep source/license information with your local library.

### Optional topic-matched photographs

You can also put licensed still images in:

```text
data/images/
```

Supported formats are PNG, JPG, JPEG, and WebP. Descriptive filenames help match images to script topics, for example `solar-energy-panels.jpg` or `computer-security-network.webp`. Matching images are added to the timeline after the moving-footage scenes, with transitions. They are optional; CreatorFlow does not invent or silently substitute placeholder images.

## 2. Optional free online stock footage

CreatorFlow can search Pixabay's video API when `PIXABAY_API_KEY` is configured. Pixabay's API is documented as free, but it requires an account/API key and is subject to provider limits and terms. CreatorFlow caches each search for at least 24 hours and downloads selected clips to the local machine before rendering.

Add this to your local `.env` file only after you obtain a key:

```env
PIXABAY_API_KEY=your_key_here
```

Do not commit your key or share it in screenshots, logs, or chat. If you do not have a key, the local footage library continues to work without one.

The application records Pixabay's source page, creator, and selected quality in the production's source-credit metadata. Review the source credits before publishing. Pixabay API documentation: https://pixabay.com/api/docs/

## 3. Hardware-adaptive rendering

The application detects CPU, RAM, and available GPU information. The footage renderer uses software H.264 encoding with the FFmpeg `ultrafast` preset, so the standard path does not depend on CUDA.

The current hardware caps are conservative:

- Integrated graphics / CPU-first: up to 960 × 540
- Entry-level dedicated GPU or RAM-rich integrated graphics: up to 1280 × 720
- Higher-end dedicated GPU: up to 1920 × 1080

The selected resolution is honored when it fits the detected profile and capped when it does not. These are output caps, not guarantees of render speed. Available RAM, CPU generation, cooling, disk speed, and source-footage size also affect performance.

## 4. Optional local AI video

Local LTX-Video remains a separate optional engine for supported NVIDIA/CUDA systems. It is not required by footage-first mode. A hardware profile can identify a possible candidate, but only a real model-runtime test can confirm compatibility. See [Local LTX setup](local-ltx-video.md).

## 5. Offline narration and optional music

On Windows, CreatorFlow can use the built-in Windows System.Speech engine to create narration without an API key. It selects an installed male voice when one is available; otherwise it uses the operating-system default voice. macOS uses its built-in `say` command. Linux can use `espeak-ng` or `espeak` when installed.

For optional background music, put a track you have permission to use in:

```text
data/music/
```

Supported formats are MP3, WAV, M4A, AAC, OGG, and FLAC. CreatorFlow selects the first alphabetically named track and mixes it quietly under narration. If the folder is empty, the video is rendered with narration only. Music is never downloaded from a paid service.

## 6. Privacy, cost, and fallback behavior

- Local-library rendering stays on the PC after the source files are present.
- Pixabay search/download uses the configured Pixabay key and the user's internet connection.
- Paid video providers remain disabled unless the operator explicitly enables them.
- No missing-footage condition silently switches to a paid provider or a slideshow.
- FFmpeg normalizes selected source clips to the chosen output profile; source audio is removed so the narration/music mix remains controlled by CreatorFlow.
