# vizualyse-steam (a bench so far)

Windows indie games on the iDrive 7 head unit through **Proton**, with
`PROTON_USE_WINED3D=1` (Direct3D on OpenGL: the unit's 4.14 kernel has no
Vulkan, [knowledge/browser.md](../../knowledge/browser.md)) and Proton's
**Wayland driver** (the unit's Mesa 19 EGL has Wayland and GBM platforms
only, no X11), drawing into our own compositor, `wl-sink`, whose pictures go
into an mgu-render frame file ([knowledge/central-screen.md](../../knowledge/central-screen.md)).
Nothing here has run on the car yet; what's next is in [TODO.md](../../TODO.md).

## The bench

```sh
sh test/run_bench.sh swrast                # every test program, Mesa 19 llvmpipe: real pixels
sh test/run_bench.sh stub t_d3d964         # the unit's own i965 on a fake HD 505: no pixels
sh test/run_bench.sh none t_gdi32          # no GPU at all
COMPOSITOR=wl-sink sh test/run_bench.sh swrast t_d3d932   # ours instead of weston
```

A trixie container (`image/bench.Dockerfile`, glibc 2.41, the browser's
base) loads the unit's own Mesa 19 (`tools/unit_gl.sh` copies it from
`../idrive-rootfs`) with a stand-in GPU from [tools/gpu-bench](../../tools/gpu-bench)
(`stub` or `swrast`, the no-op DRM shim preloaded), starts a compositor
(`weston`, or `wl-sink`), and runs each program with Proton
(`test/in_bench.sh`). Test programs (`test/win/*.c`, built 64- and 32-bit
with mingw by `test/build_win.sh`) write their lines to `T_LOG` (Proton's
`steam.exe` keeps their stdout): `t_gdi` (a GDI window), `t_d3d9` (adapter,
caps, a HAL device, frames, a triangle read back; `T_D3D9_CHECK_PIXELS=1`),
`t_xinput` (four slots), `t_load` (the D3D DLLs one by one). Afterwards
`build/out/` holds Proton's log, the programs' lines, the compositor's
events and its last picture (`snap.ppm`).

Settings: `PROTON_VER` (GE-Proton11-11), `WOW64=new|classic`, `COMPOSITOR`,
`WINEDEBUG`, `T_TIMEOUT`, `SHOW_LOG=N`, `T_ENV="-e VAR=..."` (to the
programs), `DOCKER_ARGS`.

- **Proton lives in the Docker volume `steam-bench-proton`**
  (`tools/fetch_proton.sh`: download, SHA-512, unpack, all in Linux), never on
  the Windows drive: there Windows Defender removed one of Wine's DLLs, and
  Wine loaded `libvkd3d-shader-1.dll` (which WineD3D imports) with its TLS
  data zeroed, so every Direct3D program crashed at start (2026-11-06). The
  prefix is kept in `steam-bench-pfx-<version>-<wow64>` (making one takes a
  minute).
- **32-bit games without 32-bit Linux libraries:** `PROTON_USE_WOW64=1`
  (`WINEARCH=wow64`) runs them from Wine's 64-bit side. The bench mounts over
  Proton's `lib/wine/i386-unix` a directory with only its 64-bit ELF files
  (wine64, wine64-preloader, through which Wine's own processes start), so no
  32-bit ELF of Proton's is used: the car has no 32-bit glibc or Mesa.
- **The unit's libwayland 1.15 stays out of the path**: Wine's Wayland driver
  needs 1.20 or newer (`wl_proxy_marshal_flags`); Mesa 19 runs on trixie's.
- GE-Proton 10 asks `xrandr` for the primary display and exits without one:
  `in_bench.sh` puts a stand-in on the path. In this setup it then hangs in
  its Steam-client shim, so the bench uses 11.

## wl-sink

`src/wl_sink.c`: the smallest compositor Wine's Wayland driver takes:
`wl_compositor` 4, `wl_subcompositor`, `wl_shm`, `xdg_wm_base` 5,
`wl_output` 4 (Proton's Wine wouldn't bind version 2 of either), `wl_seat`,
`wp_viewporter` (required: Wine shows its window and GL surfaces at sizes it
picks, 1x1 for hidden), and `wl_drm` 2 written here (from Mesa 19.0.6's
`wayland-drm.xml`, so Mesa's own Wayland EGL draws on the GPU and hands each
frame over as a PRIME buffer, imported through the unit's EGL on a GBM
display on the render node). The newest toplevel and its subsurfaces are
drawn centred into the frame file (BT.601 full range, `src/rgb.c`), at most
`--fps` times a second; frame callbacks are answered at that pace. It never
opens `/dev/dri/card0` (Winston's).

## Licenses

GPL-3.0-or-later. `src/protocol/wayland-drm.xml` is Mesa's, under its own
permissive notice (in the file). `src/frame_out.*` is vizualyse-chromium's.
