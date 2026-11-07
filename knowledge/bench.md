# Working on the bench

Measured on one unit (head unit software `I_21w12.2-1-4`) unless a line says otherwise. Index: [index.md](index.md).

- **The unit's root filesystem runs as a container**: `docker import
  ../idrive-rootfs/20.40.2/rootfs.tar idrive-rootfs:I_21w12.2-1-4`, then
  `/usr/bin/node` (8.16.2), BusyBox and the unit's loader as on the car (no
  `/var/opt`, no `/tmp`: make them). No GPU, no SOME/IP, no HMI
  (vizualyse-chromium's `test/run_unit_test.sh`).
- **The whole unit boots in a VM with its HMI on screen**
  ([tools/mgu-emu](../tools/mgu-emu/README.md), 2026-11-07): QEMU on Windows
  (WHPX; WSL gets no nested KVM on this AMD PC with VBS), the unit's systemd,
  Winston on llvmpipe, `HmiMain3D` showing its status bar and start screen.
  The HMI needs more than the root filesystem: `/mnt/dataro/dataro1/hmi`
  (646 MB), the IBA squashfs, `/var/sys` and `/dev/shm/rawcodingdata`. With
  stand-ins for the car's SOME/IP services (lifecycle, PWF, key, vehicle
  units/language: `tools/mgu-emu/carsim`) it reaches the home screen in
  English; no input yet. vsomeip checks a request in the serving process
  against that process's own policy file (`/etc/vsomeip/<uid>_<gid>/`), so a
  root provider must list its clients there.
- **The GPU off the car** ([tools/gpu-bench](../tools/gpu-bench/README.md),
  2026-11-06): nothing emulates the unit's Gen9 GPU (QEMU offers VGA or
  virtio-gpu only). In the rootfs container, on the unit's own Mesa 19.0.6:
  `stub` runs the unit's real `i965_dri.so` on Mesa's no-op DRM shim as an
  HD Graphics 505 (driver, shader compiler, limits; no pixels), and `swrast`
  runs Mesa 19.0.6 llvmpipe through the unit's libEGL / libgbm (pixels; not
  i965). Neither shows the kernel (i915 hangs) or the Atom's speed.
- Test frames and filter graphs on a PC first: a still from
  `winston-grabber -n 1 x.jpg` or a few seconds of its UDP stream through the
  same ffmpeg build in a Linux container, then the unit.
- Looped or generated ffmpeg inputs never end: a test with them can write
  gigabytes; bound every test run.
- Off-car aids in the reference repos ([reference-repos.md](reference-repos.md)):
  mgu-render's `--replay FILE --out F.pam` (renders a recorded client stream
  offscreen), the firmware's software Media SDK `libmfxsw64` in Docker for
  decoder tests (upstream), idrive7-apps' head-unit stub (`kit/tools/hu-stub.js`),
  and mgu-store's read-only `probe.js` for what the image has.
