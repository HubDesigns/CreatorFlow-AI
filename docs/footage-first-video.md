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

The current output profile is conservative:

- Integrated graphics / CPU-first: 960 × 540
- Entry-level dedicated GPU: 1280 × 720
- Higher-end dedicated GPU: 1920 × 1080

These are output profiles, not guarantees of render speed. Available RAM, CPU generation, cooling, disk speed, and source-footage size also affect performance.

## 4. Optional local AI video

Local LTX-Video remains a separate optional engine for supported NVIDIA/CUDA systems. It is not required by footage-first mode. A hardware profile can identify a possible candidate, but only a real model-runtime test can confirm compatibility. See [Local LTX setup](local-ltx-video.md).

## 5. Privacy, cost, and fallback behavior

- Local-library rendering stays on the PC after the source files are present.
- Pixabay search/download uses the configured Pixabay key and the user's internet connection.
- Paid video providers remain disabled unless the operator explicitly enables them.
- No missing-footage condition silently switches to a paid provider or a slideshow.
- FFmpeg normalizes selected source clips to the chosen output profile; source audio is removed so the narration/music mix remains controlled by CreatorFlow.
