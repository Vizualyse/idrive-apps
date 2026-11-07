# Winston bench: the head unit's compositor off the car

Winston (BMW's XSWayland 1.2.0.4) owns the unit's screens. Our tools can
show their pictures as clients of it (platform `native/winston_out`,
[knowledge/central-screen.md](../../knowledge/central-screen.md) "Winston
directly"). This bench runs **the unit's own `winston`**, with its own
configuration, plugins (`drm-output`, `genivi`, ...) and scene provider, in
the unit's root filesystem (the container from `../idrive-rootfs`,
[knowledge/bench.md](../../knowledge/bench.md)), on the GPU bench's stand-ins
for the GPU ([tools/gpu-bench](../gpu-bench/README.md)):

| mode | GPU | shows |
|---|---|---|
| `swrast` | llvmpipe through the unit's libEGL / libgbm | real pixels of what Winston composes; shared memory only (no dmabuf import) |
| `stub` | the unit's own i965 on the no-op GPU | Winston's renderer importing our dmabufs; no pixels |

It doesn't show the car's timing, its real display, or the HMI (nothing
draws the HMI's layers here; only their ids and order, from the scene
provider).

## Use

```sh
sh tools/winston-bench/test/run_test.sh           # all of it (~4 min): winston_out, then chromium-wl and wl-sink
sh tools/winston-bench/run.sh swrast              # Winston up, the centre screen's layers listed
sh tools/winston-bench/run.sh swrast sh -c '/bench/wo_bench app shm 800x400 108,82,1790,638 4 & sleep 2; /bench/wo_bench grab'
WINSTON_ARGS="--param stdlog-level=3" sh tools/winston-bench/run.sh stub ...   # Winston's debug lines in build/out/winston.log
sh native/vizualyse-chromium/test/run_winston_test.sh                           # the Browser end to end
```

`run.sh` starts Winston with `winston.service`'s command line (the centre
display, the virtual cluster and HUD outputs), the centre display
(`HDMI-A-1`) a null output, its socket `root:mgu_wayland` as on the car, then
runs the command in the same container. `/bench` is `build/`, `/sinks`
`build-sinks/` (our compositors with their libraries:
`test/build_sinks.sh`), `/test` this `test/`, `/out` `build/out/` (Winston's
log, pictures).

## What's in it

- `src/kms_shim.c`, preloaded into Winston only: drm-output finds its card
  through libudev (faked here: one `card0`), `/dev/dri/card0` opens the DRM
  shim's render node, and the KMS ioctls (master, caps, resources with no
  connectors, framebuffers) are answered. On swrast it orders the EGL configs
  so the GBM surface's format comes first, and gives Winston a stand-in
  front buffer (swrast's GBM surfaces have none; Winston crashed). It also
  reads back each picture of the 1920x720 output at its swap while
  `$KMS_SHIM_GRAB.req` exists.
- A null output composes only when asked for a picture: `wo_bench grab`
  asks Winston for a screenshot of the centre screen (it writes
  `/out/grab.png` itself), and kms_shim writes `/out/grab.ppm`.
- `test/wo_bench.c`: winston_out as our tools use it (`app shm|dmabuf|nv12|ring`),
  and the controller's side: `grab`, `order` (the layers on screen), `reset`
  (the HMI's way: the screen's layers set anew without ours), `camera on|off`
  (an ivi surface 0x197 made visible).
- `test/fake_client.c`: a stand-in for Chromium / Wine in front of our
  compositors (xdg-shell; shared memory, or wl_drm PRIME buffers from GBM).
- `test/sink_scenario.sh`: one of our compositors, dropped to nobody,
  between fake_client and Winston: shown, hidden, shown again.
