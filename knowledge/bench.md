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
  English. vsomeip checks a request in the serving process
  against that process's own policy file (`/etc/vsomeip/<uid>_<gid>/`), so a
  root provider must list its clients there. A click is a touch (2026-11-07):
  the HMI takes the centre display's touch not from Wayland but as AUTOSAR
  PDUs over UDP (port 30567), and only while the lifecycle `Monitor` service
  says the display is on. The controller doesn't work yet. The app platform
  and mgu-store run (2026-11-08): oapcontroller and MainApp on a software
  keystore (the 12 `ias_keystore_*` functions of libmgucrypto, preloaded),
  `/var/opt` its own disk with quotas (MainApp's app uids need
  `repquota`), the persistency tools' eCryptfs off, and the uplink on a
  second QEMU network; the updater installs apps through it.
- **The GPU off the car** ([tools/gpu-bench](../tools/gpu-bench/README.md),
  2026-11-06): nothing emulates the unit's Gen9 GPU (QEMU offers VGA or
  virtio-gpu only). In the rootfs container, on the unit's own Mesa 19.0.6:
  `stub` runs the unit's real `i965_dri.so` on Mesa's no-op DRM shim as an
  HD Graphics 505 (driver, shader compiler, limits; no pixels), and `swrast`
  runs Mesa 19.0.6 llvmpipe through the unit's libEGL / libgbm (pixels; not
  i965). Neither shows the kernel (i915 hangs) or the Atom's speed.
- **Winston off the car** ([tools/winston-bench](../tools/winston-bench),
  2026-11-07): the unit's own `winston` with its config, plugins and scene
  provider, the command line of `winston.service` but the centre display a
  null output, in the rootfs container on the GPU bench's stand-ins.
  `kms_shim.so` (preloaded into Winston only) fakes the display card
  (libudev, `/dev/dri/card0`, KMS ioctls) and reads back what Winston
  composes; a null output composes only for a screenshot, which `wo_bench
  grab` asks for. `swrast`: real pixels, shared memory only; `stub`: the
  unit's i965 imports dmabufs, no pixels. Our compositors run between a
  stand-in client (`fake_client`) and Winston; the Browser runs end to end
  (`native/vizualyse-chromium/test/run_winston_test.sh`).
- **Vulkan off the car, and one try on it** ([tools/vk-trial](../tools/vk-trial/README.md),
  2026-11-07): Mesa 19.0.6's ANV runs every stage (instance to a compute
  dispatch) on gpu-bench's stub behind a layer answering as the unit's IOTG
  4.14 kernel; the same gate and probe go to the car, armed by hand for one
  start (the arming in tmpfs `/run`, used up before anything loads, so any
  restart ends it).
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
