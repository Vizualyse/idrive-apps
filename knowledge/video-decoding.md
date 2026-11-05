# Video and decoding

Measured on one unit (head unit software `I_21w12.2-1-4`) unless a line says otherwise. Index: [index.md](index.md).

- No usable decoder on the unit for arbitrary streams: a static ffmpeg
  (John Van Sickle's 7.0.2 build) runs fine and decodes in software at low
  CPU for these sizes (about 4-5 % for the mirror at 8 fps).
- I420 to cluster-render's 4:2:0 atlas: the Y plane, then each chroma row as
  its U half followed by its V half.
- Raw H.264 (`-f h264`, e.g. from a TCP listener) with **`-fflags nobuffer`**
  gives **no frames at all** through an `fps` filter (ffmpeg 7.0.2). For a
  fast start use a small probe instead (`-probesize 32768 -analyzeduration
  0`): the first frame within a second, where default probing held it back
  3 s.

## Hardware decoding (the GPU)

*(ref)* unless a line says otherwise: not yet tried on our unit.
Sources: [reference-repos.md](reference-repos.md).

- **Proven on iDrive 7 by upstream's waze-on-cluster** (`native/waze-on-cluster/src/decoder_msdk.cpp`, `.h`; GPL-3.0): Intel **Media SDK**, not libavcodec. Open `/dev/dri/renderD128`, `vaGetDisplayDRM` + `vaInitialize`, `MFXInit(MFX_IMPL_HARDWARE | MFX_IMPL_VIA_VAAPI)` + `SetHandle(VA_DISPLAY)`, decode, then VPP scales / converts NV12 into page-aligned system-memory surfaces (pitch a multiple of 64) and the CPU packs the output.
  - Low latency: `AsyncDepth=1`, **`DecodedOrder=1`** (in display order MSDK held up to 11 frames for an SPS without VUI), one whole access unit per call with `MFX_BITSTREAM_COMPLETE_FRAME`.
  - A **new MSDK session for every sequence** (a reused one handed out surfaces from the closed pool).
  - **Reading frames back from the GPU is the cost:** ~27 % of a core at 1088x480 (upstream commit `5d48c61`). Scale on the GPU (VPP to the output size) and use `GPUCopy=ON` (`MFXInitEx`; `mfxInitParam` is 80 bytes, `GPUCopy` at offset 32; needs 16-byte aligned planes and pitch; falls back to a CPU copy). Whether the CM runtime (`igfxcmrt64`) that GPUCopy needs starts on the car is unverified.
  - Off-car tests: a fake MSDK (`test/fake_msdk.cpp`) and the firmware's own **`libmfxsw64`** (software MSDK, runs in Docker): 40 of 40 frames equal to ffmpeg's output.
- **The firmware's libraries** (upstream `native/waze-on-cluster/abi/*.symbols`, taken from the unit; mgu-store `native/mgu-render/tools/check_target.sh`):
  - `libmfxhw64-p.so.1.24` (MSDK 2017 Embedded, **API 1.24, SONAME `libmfxhw64.so`, no `libmfx.so` dispatcher**; encode too), `libmfxsw64`.
  - **`libva.so.1` / `libva-drm.so.1` 1.9900.0** (no `vaExportSurfaceHandle`). The VA driver (iHD or i965) is named nowhere: check `/usr/lib/dri` and `vaQueryVendorString` on the unit.
  - `libEGL.so.1`, `libGLESv2.so.2` (Mesa i915, `EGL_EXT_image_dma_buf_import`, maybe GLES 3), `libgbm.so.1`, `libwayland-client/egl`, wayland-ivi-extension 1.11, RAMSES 19.
  - mgu-store's `native/mgu-render/tools/car-test/probe.js` (read-only, Node 8) lists the Wayland globals, dmabuf formats, `/dev/dri` modes and holders and the GL/VA libraries mapped into HmiMain3D: the way to answer these on the car (a live action: ask first).
- **Traps for libavcodec + VA-API:** Ubuntu 18.04 links `libva.so.2`, the unit has `.so.1`; FFmpeg's QSV needs MSDK API ≥ 1.28 and the dispatcher. So link against stubs carrying the unit's SONAMEs and check the imports, as upstream does (`native/waze-on-cluster/Makefile:241-280`, `dcsm/tools/abi.py check`: glibc ≤ 2.27, GLIBCXX ≤ 3.4.24; `tools/woc_abi.py check-imports`). Porting the MSDK decoder is the proven path.
- **Access:** `/dev/dri/renderD128` is group `video` (`hmi_5000` is in it); root can open it. BMW's `winston-grabber` (encodes with MSDK, `h264_msdk` / `jpeg_msdk`) runs as `os_7011` in `mgu_wayland` + `video`.
- **No zero-copy to the screens as they are:** cluster-render ships texture bytes to the cluster; mgu-render's frame file is **I420 only**, read with `pread` (a copy) and uploaded as three `GL_LUMINANCE` textures per frame (mgu-store `native/mgu-render/src/gfx.c:449-560`). Zero-copy would need an mgu-render change (an NV12 frame file, or a dmabuf fd imported through EGL, which its EGL supports).
- The camera views (`dasvideo`, H.264 over AVB) are another production decoder on the unit (`ldd $(which dasvideo)`).
- IterioDev's Drive Recorder player (iDrive 8) decodes in **software** with FFmpeg 7.1 built into one binary (libc/libm/pthread only, gcc 7.3 on Ubuntu 18.04) and writes the renderer's frame file itself: no separate ffmpeg process.
