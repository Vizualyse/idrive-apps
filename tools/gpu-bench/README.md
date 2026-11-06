# GPU bench: the head unit's GPU off the car

Docker on a PC has no GPU the unit's driver can use (WSL2 gives `/dev/dxg`,
not i915), and nothing emulates an Intel Gen9 GPU: QEMU's GPUs are VGA or
virtio-gpu (host GL), and Intel's simulator isn't public. This bench runs a
program in the unit's own root filesystem (the container from
`../idrive-rootfs`, [knowledge/bench.md](../../knowledge/bench.md)) on the
unit's own Mesa 19.0.6 (`libEGL`, `libgbm`, `libGLESv2`, `libglapi`), with
one of two stand-ins for the GPU:

| mode | driver | shows | doesn't show |
|---|---|---|---|
| `stub` | the unit's own `i965_dri.so`, on Mesa's no-op DRM shim faking an Apollo Lake HD Graphics 505 (0x5A84) | that the real driver loads, makes contexts, compiles and links shaders (i965's own compiler), accepts the formats, extensions and limits we use; the exact `GL_RENDERER` / `GL_VERSION` the car reports | pixels (the GPU runs nothing: read-backs are zeros), timing, kernel behaviour |
| `swrast` | Mesa 19.0.6's llvmpipe (built here, same release as the unit), loaded by the unit's own libEGL / libgbm | that what we draw is right: real pixels, through the unit's EGL / GBM path | i965's extensions, limits and bugs (llvmpipe 19 is GLES 3.0, GL 3.3 core) |

Neither shows the **kernel** (the unit's IOTG i915 4.14: 0.1.1's hang in
`i915_gem_context_open`, [knowledge/browser.md](../../knowledge/browser.md))
or the **speed** of the Atom A3960. Those still need the car.

## Use

```sh
sh tools/gpu-bench/test/run_test.sh            # the bench's own test, both modes
sh tools/gpu-bench/run.sh stub                 # the smoke test (test/gltest.c), its findings
sh tools/gpu-bench/run.sh swrast               # the same, with pixels checked
MOUNT=path/to/dir sh tools/gpu-bench/run.sh stub /t/my-program   # your program
INTEL_DEBUG=fs sh tools/gpu-bench/run.sh stub  # i965's own debug output (here: fragment shader assembly)
```

`build.sh` (called by `run.sh`) builds the image once (~10 min:
`image/Dockerfile`, pinned sources) and `build/` (git-ignored): `stub/`,
`swrast/`, and every `test/*.c` linked for the unit. A program of yours must
run on the unit's libraries: glibc 2.27, linked with
`-Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2`, opening `/dev/dri/renderD128`
for its GBM device (the shim fakes that node in both modes). A program with
its own newer glibc (vizualyse-chromium's bundle) works too: the shim needs
only glibc 2.27.

Mesa's debug variables pass through when set (`INTEL_DEBUG`, `MESA_DEBUG`,
`EGL_LOG_LEVEL`, `GALLIUM_DRIVER=softpipe`, `MESA_GL_VERSION_OVERRIDE`, ...).
`DOCKER_ARGS="--cpus=1 --memory=1536m"` narrows the container, but a PC core
is not an Atom core.

## What's in it

- **The shim**: Mesa 22.3.7's `libintel_noop_drm_shim.so` (the last release
  that builds it without LLVM / libclc), built on Ubuntu 18.04 (glibc 2.27)
  with libdrm 2.4.114's headers. Preloaded, it fakes `/dev/dri/renderD128`
  and its sysfs files and answers i915's ioctls without a GPU. Two changes:
  its `bxt` means 0x5A84 (the unit's 3x6 HD 505, not the 2x6 HD 500), and
  `intel-noop-shim-pread-pwrite.patch` adds the ioctls Mesa 19's i965 uses
  that it lacked (`GEM_PWRITE` / `GEM_PREAD` into the BO, `GEM_THROTTLE`).
  An ioctl it still doesn't answer prints `DRM_SHIM: unhandled ...`.
- **swrast**: Mesa 19.0.6 `swrast_dri.so` (llvmpipe and softpipe, LLVM 6
  linked in), with `libtinfo.so.5`, which the unit lacks. Mesa 19's GBM
  platform insists on a DRM device, so swrast runs on the shim's node too,
  with `GBM_ALWAYS_SOFTWARE=1` (the "failed to open kms_swrast" line is
  expected).

## First findings (2026-11-06)

- `stub`: `Mesa DRI Intel(R) HD Graphics 505 (Broxton)`, `OpenGL ES 3.2 Mesa
  19.0.6`, as on the car; EGL 1.4, client APIs `OpenGL OpenGL_ES`, 31 GBM
  configs (all window-only); 124 GLES extensions, max texture 16384, 16x MSAA;
  **desktop GL 4.5 core (GLSL 4.50) and 3.0 compatibility contexts** through
  the unit's EGL (for the Steam / WineD3D plan; not yet seen on the car).
- `swrast`: llvmpipe (LLVM 6.0, 128 bits), GLES 3.0, desktop GL 3.1
  compatibility (no 4.5 core); pixels right.
