# iris-bench: Mesa's iris and Gallium Nine for the unit, off the car

Bench only: nothing here goes to the car. Mesa 19.3.5's **iris** (the
Gallium driver for Gen8+, the last release before 20.0 made iris refuse a
kernel without context isolation) built for the unit (glibc 2.27), patched
for the unit's 4.14 kernel, run on [tools/gpu-bench](../gpu-bench)'s stub
(the unit's HD 505 faked by Mesa's no-op DRM shim) behind
[tools/vk-trial](../vk-trial)'s `kernel414.c` (the unit's IOTG 4.14
answers). Background: [knowledge/browser.md](../../knowledge/browser.md)
("Vulkan on this kernel"), [knowledge/games.md](../../knowledge/games.md)
("iris / Gallium Nine (bench)").

```sh
sh tools/iris-bench/build.sh      # the image (~10 min once) and build/
sh tools/iris-bench/run_test.sh   # the checks below, on the stub
IRIS=1 sh native/vizualyse-steam/test/run_unit_test.sh stub   # the Steam bench's Wine (and wl-sink) on iris
IRIS=sink-unit sh native/vizualyse-steam/test/run_unit_test.sh stub   # wl-sink on the unit's i965, as on the car
```

## What it builds (`image/Dockerfile`)

| `build/` | what |
|---|---|
| `lib/libEGL.so.1`, `libgbm.so.1`, `libglapi.so.0`, `libGLESv2.so.2` | iris's own EGL / GBM / GLES set (drm, wayland, surfaceless) |
| `lib/dri/iris_dri.so`, `swrast_dri.so` | iris; softpipe (Nine insists on it) |
| `lib/d3d/d3dadapter9.so.1` | Gallium Nine's native side |
| `bench/kernel414.so` | vk-trial's 4.14 stand-in, built here |
| `bench/ninetest` | Nine's adapter on the render node |

## The patch (`image/iris_no_isolation.py`)

Only when GETPARAM `I915_PARAM_HAS_CONTEXT_ISOLATION` fails (kernels before
4.16, the unit's); a newer kernel gets stock iris:

- **CS_DEBUG_MODE2 not written; constant buffer 0 relative.** Without
  isolation the register isn't the context's own, and the HMI's i965 on
  this kernel keeps buffer 0 relative (it writes the bit only with
  isolation). `constant_buffer_0_is_relative` makes the compiler push at
  most 3 UBO ranges, which iris puts in buffers 3..1: buffer 0 unused.
- **CS_CHICKEN1 (object-level preemption) not written**: neither the unit's
  i965 nor ANV 19.0.6 ever write it.
- **No `I915_QUERY` (ioctl 0x39)**: GEM_GVTBUFFER on the unit's kernel.
  Device info's topology query (Gen9 falls back to the 4.13 getparams) and
  gen_perf's config query are skipped.

What iris then writes on its own (`INTEL_DEBUG=bat`): CACHE_MODE_1
0x00120012 and GT_MODE 0x03000100, the values the unit's i965 writes on
Gen9 LP, and L3CNTLREG (L3 partitioning, which i965 and ANV program too).

## Not shown here

The kernel and the GPU themselves (a hang, a leak into the HMI's
contexts), speed. A car try is a vk-trial-style gated run.
