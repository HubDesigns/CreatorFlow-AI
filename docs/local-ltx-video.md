# Free local video generation with LTX-Video Q8

CreatorFlow can generate real moving MP4 clips locally with the community LTX-Video Q8 implementation. This path does not use a cloud video API, subscription, or API credits.

## Hardware and limitations

The Q8 project reports a 2B-parameter, 8-bit LTX model running at 720 × 480 with 121 frames on an RTX 4060 Laptop GPU with 8 GB VRAM. This is a project-reported benchmark, not a guarantee. Laptop power limits, cooling, drivers, and other GPU workloads affect speed. CreatorFlow uses a conservative 704 × 480 profile, at most 121 frames per clip, and a low-VRAM inference flag.

The model creates silent video clips. CreatorFlow adds narration, captions, music, transitions, and final assembly separately. For a laptop GPU, begin with a small generated-clip budget rather than trying to synthesize every second of a long video.

## Runtime prerequisites

The Q8 implementation documents:
- Windows support for its CUDA kernels
- Python 3.10.12
- CUDA Toolkit 12.6 (the NVIDIA driver shown by `nvidia-smi` is not the same thing as the installed CUDA compiler/toolkit)
- PyTorch 2.5.1 with CUDA 12.6
- Visual Studio 2022 C++ build tools and Ninja for compiling the CUDA extension

The Q8 kernel project states that it was tested on Windows and requires CUDA 12.4+ and PyTorch 2.4+. The LTX Q8 implementation reports the RTX 4060 8 GB benchmark. See the upstream projects before installing:
- [LTX-Video Q8 implementation](https://github.com/KONAKONA666/LTX-Video)
- [Q8 CUDA kernels](https://github.com/KONAKONA666/q8_kernels)
- [Q8 model weights](https://huggingface.co/konakona/ltxvideo_q8)
- [Original LTX model components](https://huggingface.co/Lightricks/LTX-Video)

## Install the local runtime

Use a dedicated Python environment; do not install its CUDA/PyTorch packages into CreatorFlow's Node.js dependencies.

1. Install Python 3.10.12, CUDA Toolkit 12.6, and Visual Studio 2022 Build Tools with the C++ desktop workload. Confirm `nvcc --version` works in a new PowerShell window.
2. Create and activate a dedicated environment:

```powershell
py -3.10 -m venv "$env:USERPROFILE\CreatorFlow-LTX-venv"
& "$env:USERPROFILE\CreatorFlow-LTX-venv\Scripts\Activate.ps1"
python -m pip install --upgrade pip setuptools wheel ninja
```

3. Install the CUDA-enabled PyTorch build and Q8 kernels:

```powershell
python -m pip install torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cu126
git clone https://github.com/KONAKONA666/q8_kernels "$env:USERPROFILE\CreatorFlow-LTX\q8_kernels"
Set-Location "$env:USERPROFILE\CreatorFlow-LTX\q8_kernels"
git submodule update --init --recursive
python setup.py install
python -m pip install .
```

4. Install the LTX Q8 inference code:

```powershell
git clone https://github.com/KONAKONA666/LTX-Video "$env:USERPROFILE\CreatorFlow-LTX\LTX-Video-Q8"
Set-Location "$env:USERPROFILE\CreatorFlow-LTX\LTX-Video-Q8"
python -m pip install -e ".[inference-script]"
```

5. Download the Q8 transformer weights and the shared LTX components. These are large downloads, but they are model files rather than paid services:

```powershell
python -m pip install huggingface_hub
New-Item -ItemType Directory -Force "$env:USERPROFILE\CreatorFlow-LTX\ltxvideo_q8" | Out-Null
New-Item -ItemType Directory -Force "$env:USERPROFILE\CreatorFlow-LTX\LTX-Video-Base" | Out-Null
python -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='konakona/ltxvideo_q8', local_dir=r'$env:USERPROFILE\CreatorFlow-LTX\ltxvideo_q8')"
python -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='Lightricks/LTX-Video', local_dir=r'$env:USERPROFILE\CreatorFlow-LTX\LTX-Video-Base', allow_patterns=['text_encoder/**','vae/**','scheduler/**'])"
```

The base directory must contain `text_encoder`, `vae`, and `scheduler` subfolders. The Q8 transformer directory must contain the downloaded transformer files. Hugging Face may require accepting the model's terms before downloading.

## Configure CreatorFlow

Add these entries to your local `.env` file. Keep the paths exactly as installed above:

```env
VIDEO_PROVIDER=local_ltx
VIDEO_PROVIDER_ORDER=local_ltx
VIDEO_CLIP_DURATION=5
VIDEO_MAX_GENERATED_SECONDS=20
LTX_PYTHON=C:\Users\YOUR_WINDOWS_USER\CreatorFlow-LTX-venv\Scripts\python.exe
LTX_VIDEO_HOME=C:\Users\YOUR_WINDOWS_USER\CreatorFlow-LTX\LTX-Video-Q8
LTX_CHECKPOINT_DIR=C:\Users\YOUR_WINDOWS_USER\CreatorFlow-LTX\LTX-Video-Base
LTX_UNET_PATH=C:\Users\YOUR_WINDOWS_USER\CreatorFlow-LTX\ltxvideo_q8
LTX_WIDTH=704
LTX_HEIGHT=480
LTX_FRAME_RATE=25
LTX_INFERENCE_STEPS=30
LTX_TIMEOUT_MS=5400000
```

Replace `YOUR_WINDOWS_USER` with your Windows profile folder name. Use absolute paths. Setting `VIDEO_PROVIDER=local_ltx` is deliberate: when the local model is unavailable, production fails with a setup error instead of silently switching to a paid cloud provider.

Restart CreatorFlow after editing `.env`. The read-only endpoint `GET /api/video-providers` should list `local_ltx` as available after the required directories exist. This checks installation paths only; it does not prove that CUDA kernels can load or that a full inference will succeed.

## First test

Do not enable scheduled publishing or run a full production yet. First verify Python, CUDA, and the Q8 extension:

```powershell
& "$env:USERPROFILE\CreatorFlow-LTX-venv\Scripts\python.exe" -c "import torch; import q8_kernels; print('Torch:', torch.__version__); print('Torch CUDA:', torch.version.cuda); print('CUDA available:', torch.cuda.is_available()); print('GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'not available')"
```

Then run one short local clip from CreatorFlow and inspect the resulting MP4 before increasing the clip budget. A local inference test uses your laptop's electricity and storage, but does not incur a video API charge.

## Licensing

The Q8 model card lists Apache-2.0; the Q8 CUDA kernels project lists MIT. Check the upstream model and code licenses again before commercial redistribution, and retain their required notices.
