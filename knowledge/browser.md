# A browser on the unit (Chromium, WebGL, WebGPU)

What we found building vizualyse-chromium
([`native/vizualyse-chromium`](../native/vizualyse-chromium)). From the
rootfs copy of `I_21w12.2-1-4` (`../idrive-rootfs`) and its container
(2026-11-05), 0.1.0 and 0.1.1 on the car (2026-11-05, 2026-11-06). Index: [index.md](index.md).

## No GPU driver without a safety net (the black screen, 2026-11-06)

**The rule:** never ship a GPU driver that is known to hang the unit (Mesa
22.3's ANV, below; any Mesa ≥ 23.2's ANV, which needs context isolation).
Trying another driver is allowed, but only with a recovery path that works
without us at the car, so a hang costs at most one restart:

- never started at boot or by the tool on its own until it has been seen
  working; by hand only;
- a marker in `/var/opt` written before the GPU is opened and cleared after
  it worked: a marker left over at the next start means the last try hung,
  so that start uses the CPU or the unit's own Mesa 19 instead (the journal
  doesn't survive the restart, so the marker is the only witness);
- tried first on a bench with the same GPU and kernel (below) where one
  exists, and an SSH way back (renaming the ICD) known before the car try.

- **0.1.1 with Mesa 22.3's ANV (Vulkan) blacked out the HMI and restarted
  the unit on every boot.** Chromium's GPU process hung in the kernel
  opening the GPU (`drm_open` → `i915_driver_open` → `i915_gem_open` →
  `i915_gem_context_open`, task in D state, unkillable), holding the DRM
  lock; the HMI's `viewmanager_Map`, `gvviewmanager_G` and `NmeVideoDevice`
  then blocked in `drm_stub_open` → `mutex_lock` ("blocked for more than 10
  seconds" in `dmesg`), nothing drew, and the unit restarted about a minute
  later. The tool starts Chromium at boot, so every boot did it again.
  Renaming the bundle's ICD (`intel_icd.json`) over SSH ended the loop.
- **The task stuck in `i915_gem_context_open` was most likely a victim, not
  the culprit** (read in Intel's public 4.14 tree, not seen on the car):
  there every open of a DRM node takes `struct_mutex` with an
  uninterruptible `mutex_lock` (`i915_gem_context.c`, `4.14/base` of
  [intel/linux-intel-lts](https://github.com/intel/linux-intel-lts)), so a
  D-state task there is waiting for whoever holds the lock: probably an
  earlier ANV ioctl of the same process stuck on a GPU hang. We only logged
  the waiters. Next time `echo w > /proc/sysrq-trigger` (blocked tasks
  with stacks) would name the holder. That tree also defers hardware setup
  to the first open (`i915_gem_context_first_open` →
  `i915_gem_init_hw_late`), which mainline doesn't do.
- The kernel is Intel's own IOTG i915 build (`IOTG i915 driver 2019y-05m-22d`,
  `[drm] Initialized i915 1.6.0 20170818`, GuC 9.37 loaded), not mainline 4.14:
  a Mesa written for mainline can't be trusted on it, and the bench (no GPU,
  no kernel) can't show a hang.
- Everything of ours that uses the GPU safely uses **the unit's own
  userspace drivers**: mgu-render (Mesa 19 EGL / GLES, i965, on Winston),
  Moonlight (MSDK + iHD libva). 0.1.2 has no GPU driver, and Chromium runs
  without the group `video`, so it can't open `/dev/dri` at all; 0.2.0's
  GPU mode uses the unit's own Mesa 19 (below), by hand only.
- No persistent journal on the unit: after a restart only the current
  boot's logs remain (`journalctl -b -1` fails).

## WebGL on the unit's own Mesa 19 (the GPU mode, 0.2.0)

Checked in the rootfs container (2026-11-06); no GPU there, so not whether
it renders.

- The unit's GL stack (`/usr/lib`): Mesa 19.0.6 `libEGL.so.1`,
  `libGLESv2.so.2`, `libgbm.so.1`, `libglapi.so.0`, **no glvnd**; one DRI
  driver, `/usr/lib/dri/i965_dri.so` (→ `/etc/alternatives` →
  `/usr/lib/dri/mesa/`), no swrast. libEGL needs only GLIBC ≤ 2.17, i965
  GLIBC 2.27 / GLIBCXX_3.4 / CXXABI_1.3.9.
- **EGL platforms: wayland and drm (gbm) only**: "Surfaceless platform not
  built", "X11 platform not built"; client extensions
  `EGL_EXT_platform_base`, `EGL_EXT_platform_wayland`,
  `EGL_MESA_platform_gbm`, `EGL_EXT_device_base/enumeration/query`, **no**
  `EGL_MESA_platform_surfaceless` or `EGL_EXT_platform_device`. Display
  extensions include `EGL_KHR_surfaceless_context`,
  `EGL_KHR_no_config_context`, `EGL_EXT_image_dma_buf_import(_modifiers)`.
  i965 gives Gen9 OpenGL ES 3.2 (WebGL 2 needs 3.0 from ANGLE's GLES
  backend).
- On the drm platform without a gbm device Mesa opens **`/dev/dri/card0`**
  (`"%s/card%d"`), the display node Winston is master of; a GBM device made
  on **`/dev/dri/renderD128`** and `eglGetPlatformDisplayEXT(
  EGL_PLATFORM_GBM_MESA, ...)` avoids it (the GPU mode's `gpu/egl_shim.c`).
- Headless Chromium (Ozone headless) allows only ANGLE (`--use-gl=egl`
  is refused); `--use-angle=gles-egl` makes ANGLE `dlopen("libEGL.so.1")`
  in the GPU process and call `eglGetDisplay(EGL_DEFAULT_DISPLAY)` (its
  preferred-display path needs `EGL_EXT_platform_device`), loading the rest
  through `eglGetProcAddress`. Debian's `chromium` links ANGLE in and
  doesn't need `libEGL`; its `libEGL.so` / `libGLESv2.so` beside it are
  stubs. Dawn also opens `libEGL.so.1` looking for a GLES adapter.
- Loading the unit's libraries into our glibc 2.41 process: the **unit's
  `libdl.so.2`, `libpthread.so.0`, `librt.so.1` must not load** (2.27:
  `undefined symbol: _dl_catch_error, version GLIBC_PRIVATE`): the bundle
  carries trixie's stubs. Mesa 19's EGL needs **its own libgbm** (it reads
  gbm's internals), so the unit's `libgbm.so.1` replaces the bundle's for
  the whole Chromium in the GPU mode (Chromium imports only
  `gbm_bo_get_fd_for_plane` beyond Mesa 19's gbm, and weakly). The bundle's
  newer libdrm, libexpat, libz, libstdc++ serve Mesa 19 fine; libglapi,
  Wayland and libffi 6 come from the unit.

- **On the car (0.2.0, 2026-11-06):** the shim's GBM display on
  `renderD128` opened (`egl-shim: display: GBM on /dev/dri/renderD128`), no
  hang, nothing in `dmesg`; then Chromium's GPU process: `No suitable EGL
  configs found` → `CreateOffscreenGLSurface failed` → `Exiting GPU process`,
  and the tool went back to the CPU. Chromium's `ChooseConfig`
  (`ui/gl/gl_surface_egl.cc`) asks for `EGL_SURFACE_TYPE` with
  `EGL_PBUFFER_BIT` for offscreen surfaces; ANGLE's configs mirror the
  native ones, and Mesa 19's GBM platform offers window surfaces only. 0.2.1
  emulates pbuffers in the shim (window configs say pbuffer; a pbuffer is a
  GBM surface with a window surface on it, its swaps skipped).
- **0.2.1 on the car: WebGL 2 on the GPU.** `ANGLE (Intel Open Source
  Technology Center, Mesa DRI Intel(R) HD Graphics 505 (Broxton) , OpenGL ES
  3.2)`; `chrome://gpu`: compositing and canvas hardware accelerated,
  Skia on Ganesh GL; nothing in `dmesg`. (Mesa names the chip Broxton,
  Vulkan "APL 3".)
- **WebGPU on the same driver (0.2.2):** `--use-webgpu-adapter=opengles
  --force-webgpu-compat` give every page a compatibility-mode adapter on
  Dawn's GLES backend over ANGLE (Linux leaves that backend off otherwise:
  "Deliberately disable compat on linux"); seen working on ANGLE /
  SwiftShader in the container. `adapter.info.backend` needs
  `--enable-webgpu-developer-features`; compatibility adapters lack the
  `core-features-and-limits` feature. Right after the GPU process restarts
  an adapter can be stale (`requestDevice`: "A valid external Instance
  reference no longer exists"): ask for a new one.

## Memory (the car, 2026-11-06)

- 5.6 GB RAM, ~1.4 GB available and 1.6 of 3 GB zram swap in use with the
  browser loaded. A big WebGPU game on SwiftShader (vel.gg) filled the
  1536 MB cgroup for minutes (`memory.failcnt` 349441), then the kernel
  killed Chromium's GPU process (`Killed process ... (chromium)`,
  `memory.oom_control` `oom_kill 1`; Chromium: `GPU process exited
  unexpectedly: exit_code=9`); the page's WebGPU device was lost. The HMI was
  untouched: the kill stays inside the cgroup.
- **Who uses it** (vel.gg in the GPU mode at a 2.5 GB cap; RSS + swap):
  Chromium 2.4 GB (game renderer 1.4 GB, GPU process 0.7 GB, 0.8 GB of it
  shmem); HmiMain3D 216 MB **+202 MB swapped**; navigation (NavigationBasic,
  NavigationFully, NavController) 355 + 99 MB; BMW's OAP apps ~750 MB
  (oap-cdc-2018 139, road-ahead 92, smartinterior 92, trigger_service 72,
  data-collection 60, message_handling 53, connected-onboard 52,
  ts_diagnostic_service 52, privacy_manager 44, x_call 44, MainApp 48);
  natp, media, audio, telematics ~250 MB; the Store's `mgu-updater` daemon
  237 MB and its app 84 MB; Moonlight and Cast ~50 + 40 MB. `MemAvailable`
  377 MB; zram held 1.2 GB in 300 MB. Everything not BMW's comes to ~550 MB.
  Per process: `VmRSS` / `VmSwap` in `/proc/<pid>/status`, PSS in
  `smaps_rollup` (4.14 has it); an OAP app's name in
  `/var/opt/public/oap/oap_<uid>/source/package.json`.
- **CPU then:** load 9.9 on 4 cores, 92 % busy: the game's renderer ~30 % of
  all, the GPU process ~19 % (WebGPU through Dawn GLES, ANGLE and Mesa all on
  the CPU side), the browser process ~8 % (screencast JPEGs); ~3 pictures
  per second reached the screen.
- **Chromium memory switches** (checked in 156's source, not just blogs, which
  were thin and contradictory): `--disable-site-isolation-trials` (also turns
  off the default desktop site isolation, despite its name),
  `--renderer-process-limit`, `--process-per-site` (consolidation, unlike
  `--site-per-process`), features `SpareRendererForSitePerProcess` and
  `BackForwardCache`, `--force-gpu-mem-available-mb` (a renderer switch: the
  compositor's GPU memory) and `--force-gpu-mem-discardable-limit-mb`, both
  configurable in Fuchsia's WebEngine for small devices.
  `--enable-low-end-device-mode` makes the renderer set V8
  `--optimize-for-size` (render_process_impl.cc); Blink's low-end limits are
  mostly Android-only. DevTools `Memory.simulatePressureNotification` drops
  caches in all processes on demand.

## Touch over the HMI

- A layer over the app area gets no touch of its own: the tool reads a
  copy of the display's PDUs, and **the HMI still gets every touch and
  presses whatever widget of the app's page lies under the browser** (seen
  on the car with 0.1.0: the Browser page's buttons). Claiming touch
  through mgu-render is what restarted the unit twice. 0.1.1 opens an empty
  sub-state (a label, nothing focusable) under the browser and disables the
  main page's buttons while it is up; not yet seen on the car.

## What the image has

- **Mesa 19.0.6** (`mesa-megadriver`, `libegl-mesa`, `libgles2-mesa`,
  `libgbm1`): the old **`i965_dri.so`** only (`/usr/lib/dri/mesa/`, through
  `/etc/alternatives`). **No Vulkan**: no `libvulkan`, no ICD, no ANV. So no
  WebGPU from the system; a newer Mesa has to come along.
- glibc 2.27, libstdc++ 3.4.24 (gcc 7.5), libdrm 2.4.96, Wayland 1.15,
  freetype, expat, glib, dbus, alsa. **No** NSS, fontconfig, X11 or libpci.
- Kernel `4.14.147-apl` (Intel's IASGP `gp1.0.6_ln4.14` build). cgroup v1
  `memory` is mounted (`/sys/fs/cgroup/memory`), cgroup2 too.
- `/dev/dri/renderD128` is group **`video` = gid 44** (members include
  `hmi_5000`, `media`, `os_7011` the grabber).

## A newer userland on the unit

- A binary built on a current distro runs if it brings **its own glibc and
  loader** and asks for that loader by absolute path (`patchelf
  --set-interpreter /var/opt/<tool>/.../ld-linux-x86-64.so.2`), with
  `LD_LIBRARY_PATH` pointing at its libraries. Chromium's children re-exec
  `/proc/self/exe`, so the loader must be the interpreter, not a wrapper.
- **`LD_LIBRARY_PATH` must not reach the unit's own programs**: BusyBox `sh`
  started with it loads the bundle's libc on the unit's loader and dies
  (`version GLIBC_2.35 not found`). Set it on the final `exec` only.
- **Mesa 25.0's ANV does not run on the unit (seen on the car,
  2026-11-05):** `Vulkan requires context isolation for Intel(R) HD Graphics
  505 (APL 3) (VK_ERROR_INCOMPATIBLE_DRIVER)`
  (`anv_physical_device.c:2445`). The 4.14 kernel lacks
  `I915_PARAM_HAS_CONTEXT_ISOLATION` (4.16+); iris (GL) refuses it too
  ("Kernel is too old (4.16+ required)"). The gem wait / execbuf2 / softpin /
  fence array checks in `i915/anv_device.c` pass, they are not the gate.
  Both refusals are checks in Mesa's code, not something the kernel can't
  do: patching them (restoring what ANV 18.2-23.1 did without isolation,
  below) is untried. A first look, not a verdict.
- **Mesa 22.3's ANV** (Debian bookworm, `22.3.6-1+deb12u2`) has no such gate:
  it reads the param and, without it, makes constant buffer 0 relative
  (`anv_device.c:794, 963`). Its `libvulkan_intel.so` binds against trixie's
  newer libraries (checked with `RTLD_NOW`). **On the car it hung the
  kernel** (above), once, at boot, with no witness of which ioctl: never
  ship it this way again. Retrying it (or any newer ANV) goes through
  `tools/vk-trial` (crumbs, `sysrq w`) to find out why; the cause is unknown,
  not a property of 22.3 we know of.
- With no Vulkan device, Chromium's GPU process exits on every start
  (`ANGLE Display::initialize ... Internal Vulkan error (-3)`), and Chromium
  turns WebGL off (webglreport: "supports WebGL but it is disabled or
  unavailable"); `--enable-unsafe-swiftshader` keeps WebGL on the CPU instead.
- Gen9 is ANV's (Gen8 went to `hasvk`).

## Vulkan on this kernel: what Mesa's history says (2026-11-06)

From a blobless clone of `gitlab.freedesktop.org/mesa/mesa` (its web pages
refuse scripts; `git` works) and a web search.

- **ANV ran on Apollo Lake with old vendor kernels.** `3b363d5b552` (2021,
  "anv: Assume syncobj support") lists ChromeOS's kernels then: "kernel
  4.4: BYT, KBL, APL", with features back-ported. So ANV on a 4.x kernel
  without context isolation was a shipped setup, on ChromeOS's kernels.
- **Context isolation** (`I915_PARAM_HAS_CONTEXT_ISOLATION`, Linux 4.16;
  absent from Intel's 4.14 tree too) became optional in ANV in Mesa 18.2
  (`be18d5a0ce8`, `ba2c18763b2`, 2018): without it ANV keeps constant
  buffer 0 relative and doesn't write `CS_DEBUG_MODE2`. **Mesa 23.2
  dropped that** (`8a1a49aae40`, May 2023, "anv: assume context isolation
  support", issue 7265): it refuses the device ("Vulkan requires context
  isolation") and writes `CS_DEBUG_MODE2` unconditionally, a register that
  without isolation would leak into other contexts (the HMI's). So **ANV
  from Mesa 18.2 to 23.1 runs here as it is**; 23.2 and later need that
  commit reverted in a build of our own (the check, the relative constant
  buffer 0, no `CS_DEBUG_MODE2` write): more work, untried, not ruled out.
  Mesa 25.3 also requires Linux 6.0 and newer i915 features
  (`affee04bd9c`, `8044f16bd69`, `cb5a2eafd52`, `f28eb1bae66`, Aug 2025):
  much harder to get past than one check.
- **What a newer Mesa would bring the games** (sources read 2026-11-08,
  `gitlab.freedesktop.org/mesa/mesa/-/raw/<tag>/...`): ANV from **19.1** has
  `VK_EXT_host_query_reset` (DXVK 1.10.x's requirement on record; the rest
  unchecked); Vulkan 1.3 (DXVK 2.x) from Mesa 22. **iris 19.3.5 has no
  context-isolation check** (`iris_screen.c`; it arrives in 20.0), and it
  loads on the 4.14 stand-in, but **stock it isn't safe here**: it writes
  CS_DEBUG_MODE2 (constant buffer 0 absolute) unconditionally, the
  register that isn't the context's own without isolation and that the
  HMI's i965 leaves alone on this kernel (buffer 0 relative); and it asks
  `I915_QUERY` (ioctl 0x39), GEM_GVTBUFFER on the unit's kernel.
  [tools/iris-bench](../tools/iris-bench/README.md) patches both (and
  CS_CHICKEN1) for kernels without isolation; on the stub it then writes
  only what i965 writes (2026-11-08, [games.md](games.md) "iris / Gallium
  Nine (bench)"). **Any newer `src/intel` (ANV 19.3+, too?) may ask 0x39
  the same way**: check with kernel414's HAZARD before a car try.
- **The first candidate (now proven, below): ANV from Mesa 19.0.6**, the release the
  unit's own i965 is from (same era as the kernel, no context-isolation
  dependence), built for the unit's glibc, under the safety net above.
  Mesa 22.3 hung, and why is not known; an older ANV may hang the same way.
- **Mesa 19.0.6's ANV off the car (2026-11-07, [tools/vk-trial](../tools/vk-trial/README.md)):**
  built for glibc 2.27, it runs in the unit's rootfs on gpu-bench's stub
  HD 505 through every stage: `Intel(R) HD Graphics 505 (Broxton)`, Vulkan
  1.0.96 to our 1.0 instance, driver 19.0.6, `8086:5a84`; a device; a compute
  dispatch submitted (the stub runs nothing). Every ioctl answered, the
  display node never asked for. Told no context isolation (as the unit's
  kernel), it goes on. What it asks the kernel that the unit's own i965
  (which runs on the car every day) doesn't: syncobjs (create / wait /
  destroy, already while enumerating), `GEM_SET_CACHING`, `GEM_GET_TILING`,
  params 9, 19, 43 and 49; it submits without `I915_EXEC_BATCH_FIRST`. Both
  softpin every buffer at 48-bit addresses (the stub says the GTT is 2^48;
  the car's answer is unknown: `enable_ppgtt`). **`vkCreateDevice` already
  runs two batches on the GPU and waits for them with no timeout**, so the
  first GPU work is the `device` stage, not the first draw.
- **vk-trial's dry run on the car (2026-11-07, no driver: a placeholder,
  shell-script children):** every gate safety held. Unarmed and second runs
  did nothing; the arming was gone before the child started; the child ran
  as uid 12990 / group 44 with core limit 1; in its own namespace `card0`
  was `/dev/null` (absolute, relative, by-path) while pid 1 and the gate saw
  the real node and no mount, during and after; a 5 s timeout killed it and
  the real `sysrq w` dump (56 lines with stacks) landed in `kmsg.log`; a
  killed gate left a child that blocked arming, then closed as `died`. Only
  miss: a killed gate's ICD stayed in `/run` (fixed: closing the try removes
  it). The unit's facts for this: `/run` tmpfs; **`/` mounted `shared:1`**
  (a namespace must be made private or a bind leaks system-wide); SSH is
  systemd's `sshd.socket` on `[::]:22` (`Accept=yes`, `sshd -i` per
  login, nothing of the GPU on the way in); `core_pattern` pipes to
  `dlt-cdh`; `hung_task_timeout_secs` 10; i915 `enable_ppgtt=3` (full 48-bit,
  as the bench stub says), `enable_gvt=N`. **A healthy unit already has
  blocked tasks** in `sysrq w` (`main`, pid 426, D state): the baseline when
  reading a dump after a try.
- **Mesa 19.0.6's ANV on the car, stage `instance` (2026-11-07, vk-trial):
  ok.** The Khronos loader 1.1.70 and ANV load in the unit's userland
  (glibc 2.27, libdrm 2.4.96) and make an instance: 12 instance extensions,
  none enabled; no `/dev/dri` opened (crumbs), nothing in `dmesg`, 1 s.
- **Stage `enumerate` on the car (2026-11-07): ok.** ANV opened only the
  render node: `Intel(R) HD Graphics 505 (Broxton)`, **Vulkan 1.1.96**,
  `8086:5a84`, heap 0 3185 MB; nothing in `dmesg`. The kernel's answers:
  GTT 2^48, 3 subslices, 18 EUs, context isolation EINVAL, params 9, 19,
  37, 43, 44, 45, 49 all 1, **`MMAP_VERSION` 1** (the shim says 4), and **a
  wait on a fresh syncobj `ETIME`** (the shim said 0). That last answer
  turns on ANV's syncobj fences, hence 1.1 (the bench had said 1.0). The
  bench's `kernel414` now answers both as the car does; ANV's path there
  changed only at `compute`: its dispatch goes out with
  `I915_EXEC_FENCE_ARRAY` (flags `0x81801`) and is waited for with
  `SYNCOBJ_WAIT`, which the unit's i965 never does. `device` stays two
  batches (`0x1801`) waited for with `GEM_WAIT` without a timeout.
- **Stage `device` on the car (2026-11-07): ok, ANV's first GPU work.** A
  context (priority 0), seven buffers (`GEM_CREATE`, `GEM_MMAP`,
  `GEM_SET_CACHING`), the two device-init batches executed: each
  `GEM_WAIT` came back after ~5 µs of the GPU's time (the kernel counts the
  timeout down), then everything closed and the context destroyed.
  Nothing in `dmesg`, no hang; the HMI and Winston kept running, same boot.
  So ANV 19.0.6 runs work on this IOTG 4.14 kernel without context
  isolation; whatever hung Mesa 22.3's ANV (0.1.1) isn't in this path.
- **Stage `compute` on the car (2026-11-07): ok, Vulkan compute works.**
  The shader compiled (ANV's own compiler, ~6 ms), the dispatch went out
  with a fence array (`0x81801`, 7 buffers softpinned) and `SYNCOBJ_WAIT`
  returned it done within ~3 ms: **1024 of 1024 numbers right**
  (`i * 3 + 7`). Nothing in `dmesg`, the HMI unchanged, same boot. Mesa
  19.0.6's ANV is a working Vulkan 1.1 driver on the unit, under vk-trial
  (by hand, one start per arming); not yet anything that draws or presents.
- **Stage `draw` on the car (2026-11-07): ok, Vulkan graphics works
  offscreen.** A render pass cleared a 256x256 tiled RGBA image, a graphics
  pipeline (vertex + fragment shader, ~10 ms to compile) drew one triangle
  coloured by position, and the image was copied into a buffer: **65536 of
  65536 pixels right** (32640 in the triangle, 32640 cleared, the 256 on
  its edge either). One 5.9 KB batch of 3D state, 8 buffers, the fence
  array again; done within ~3 ms. No new kind of ioctl; nothing in `dmesg`,
  same boot. The probe's own expectations were first checked on lavapipe
  (Debian bookworm, `test/lavapipe_test.sh`), which got the same 65536.
- **Presenting through Wayland, off the car (2026-11-07, vk-trial's
  `present` stage):** ANV rebuilt with `-Dplatforms=drm,wayland` needs only
  `libwayland-client.so.0` more, and all 18 `wl_` symbols it imports are in
  the unit's own (older) build. Its surface offers `B8G8R8A8_SRGB` and
  `_UNORM`, at least 4 images; a FIFO swapchain makes 5 X-tiled images
  (`GEM_SET_TILING`) shared as PRIME fds. Into our wl-sink on the stub: 60
  frames presented, wl-sink made 60 pictures from 60 `wl_drm` buffers
  imported through the unit's i965 (`PRIME_FD_TO_HANDLE`, `GEM_GET_TILING`),
  none by shared memory. Each present adds a tiny batch (`0x81001`, one
  buffer below 4 GB) signalling a syncobj. On lavapipe the picture wl-sink
  composed was right in every pixel. wl-sink as on main needs libwayland ≥
  1.20 (`wl_output` 4, newer xdg-shell): the unit's is older, so vk-trial
  ships a libwayland-server 1.22 built for glibc 2.27 for it alone.
  Winston offers `zwp_linux_dmabuf_v1` and `wl_drm` (seen on the car), so
  the same buffers could go to it directly (the Winston session's
  `winston_out`, branch `winston-render`).
- **Stage `present` on the car (2026-11-07): ok, ANV's frames through
  Wayland.** 60 FIFO frames into our wl-sink (pid beside the probe's, both
  uid 12990, `card0` hidden), every one a `wl_drm` PRIME buffer imported
  and read back through the unit's i965 (`drm":true` on the render node):
  **wl-sink's picture 65536 of 65536 pixels right**, no shared memory, 6 s
  for the whole probe, nothing in `dmesg`, same boot, the HMI unchanged,
  nothing left (no wl-sink, no `/tmp/vkprobe-*`, `/run/vk-trial` empty).
  Still nothing on the screen: wl-sink keeps its frames to itself. (That
  run's "109 GPU buffers" was the probe adding up wl-sink's running total;
  fixed after: `drm`/`shm` are totals, `pictures` per line.)
- **DXVK under Proton on ANV 19.0.6, off the car (2026-11-07,
  `tools/vk-trial/dxvk`):** DXVK **1.9.4** is the newest that fits. 2.x and
  GE-Proton 11's own 3.1.1 need Vulkan 1.3; DXVK 1.10.3 found the device
  but refused every feature level ("Requested feature level not
  supported"): from 9_1 up it wants `VK_EXT_host_query_reset`
  (`hostQueryReset`), which ANV has from Mesa 19.1, and Mesa 19.0.6's
  Vulkan headers (version 97) predate it, so no small backport. 1.9.4 needs
  transform feedback from 10_0, which ANV 19.0 has. Through GE-Proton 11's
  Wine (`winevulkan`, the Wayland driver) on the stub: D3D11 at **feature
  level 11_1** and D3D9 (VS / PS 3.0, max texture 16384) on `Intel(R) HD
  Graphics 505 (Broxton)`, 60 frames each into wl-sink as `wl_drm` GPU
  buffers; also with the Steam tool's real bundles in the unit's rootfs
  through vk-trial's gate (uid 12990, a private prefix copy, ~260 MB). The
  Steam runtime has no Vulkan loader (its bundle.sh refuses GPU drivers and
  ICDs): vk-trial's loader 1.1.70 works under Wine. DXVK's D3D9 reports the
  driver as `igdumd64.dll`.
- **DXVK under Proton on the car (2026-11-07, vk-trial `command` try):
  works, real pixels.** GE-Proton 11's Wine from the Steam tool's bundles,
  DXVK 1.9.4 in a private prefix, ANV 19.0.6: D3D11 at feature level 11_1,
  60 frames, the back buffer read back exactly (255 64 0); D3D9, 60 frames,
  its pixel check right; 120 frames into wl-sink as GPU buffers; 386 GPU
  submissions, 23 s, nothing in the kernel log, no hang, same boot.
  Adapter memory as DXVK reports it: 4209 MB.
- **The same on the screen through Winston (2026-11-08, `--winston`, `run.js
  run winston`):** the trial's child with group `mgu_wayland` too; wl-sink
  connected to Winston (dmabuf v1, 13 formats), our surface `0x565a0100` on
  layer `0x565a0000` in the app area (108,82 1790x638), "on the screen":
  137 pictures, **120 of them ANV's GPU buffers passed to Winston as they
  are** (no read-back, no copy); pixels read back right in both programs,
  25 s, no hang, same boot, nothing left. Not yet: a real game, 32-bit
  (WoW64 needs placed / host memory mapping in winevulkan), a long run.
- **The unit's kernel isn't mainline 4.14** (its uapi header,
  `intel/linux-intel-lts` `4.14/base`): it has context param 6
  (`PRIORITY`) like 4.15, and **i915 ioctl 0x39 is `GEM_GVTBUFFER`** where
  later kernels put `QUERY`: a newer userspace asking `DRM_IOCTL_I915_QUERY`
  reaches a GVT handler with the wrong struct (the DRM core dispatches by
  number). Mesa 19.0.6's ANV never asks it; its i965 does, but only for
  performance queries (`brw_performance_query.c`). Mesa 22.3's ANV
  (0.1.1's) asks it at every device open (`intel_device_info.c`: topology,
  memory regions). The IOTG table allows it on render nodes
  (`DRM_RENDER_ALLOW`); `i915_gem_gvtbuffer_ioctl` then reads the 16-byte
  query as a zero-extended gvtbuffer: `id` 1, `start` 0, so it decodes a GVT
  framebuffer (`gvt_decode_fb_format(dev_priv->gvt, 1, ...)`) and most likely
  fails on `pipe_id` (the low half of a user pointer, out of range) with
  EINVAL, after which Mesa falls back to GETPARAM. So probably harmless, but
  a different handler than Mesa expects and one worth ruling out for 0.1.1's
  hang; not proven either way. vk-trial's bench layer flags any program that
  asks.
- **A bench with the same GPU** is the way to see a hang off the car: an
  Apollo Lake mini PC (Celeron N3350 / Pentium N4200, HD 500 / 505) on
  Intel's public 4.14 kernel (`intel/linux-intel-lts`, `4.14/base`,
  `4.14/yocto/base`). The unit's i915 reports its own build (`IOTG i915
  driver 2019y-05m-22d`), so close but not identical.
- **Nothing else found:** no Vulkan-over-GLES layer exists (the known ones
  go the other way: GLOVE, Zink); rpi-vk-driver (a hobby Vulkan for the old
  Raspberry Pi GPU) and Turnip's KGSL backend (Mesa on Qualcomm's vendor
  kernels) show a driver fitted to an old or vendor kernel, at years of
  work. Software Vulkan (lavapipe, SwiftShader) is the only one with no
  kernel risk, too slow on these 4 Atom cores for DXVK games, hence
  WineD3D on Mesa 19 GL for Steam games. Intel's own platforms for this
  chip (ACRN GVT-g, Gordon Peak, Celadon) turned up nothing on Vulkan.
- Libraries Chromium only `dlopen`s, which `ldd` can't see: NSS's
  `libsoftokn3`, `libfreebl3`, `libfreeblpriv3`, `libnssckbi`, `libnssdbm3`
  (without them Chromium aborts at the first TLS: `nss_util.cc ... -5925`),
  `libpci.so.3`. Debian's Chromium carries its own `libvulkan.so.1` loader
  and SwiftShader.

## Chromium (Debian trixie's 156)

- Headless (`--headless`, Ozone headless) uses the GPU with
  `--use-angle=vulkan --enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan
  --enable-unsafe-webgpu --disable-vulkan-surface`; `chrome://gpu` then
  says WebGL / WebGPU "Hardware accelerated" (compositing stays software).
  Chromium enables WebGPU on Linux only for Intel Gen12+ by itself, hence
  `--enable-unsafe-webgpu` for the Gen9 HD 505.
- **WebAssembly JSPI** (`WebAssembly.Suspending` / `promising`) is on by
  default since Chromium 137: no flag.
- `navigator.gpu` exists only in a **secure context**: not on `about:blank`
  or `data:`; `http://127.0.0.1` counts. A new tab from
  `Target.createTarget` runs scripts in its initial `about:blank` until the
  URL commits: wait for `location.href`.
- `Page.startScreencast` (JPEG) works headless; pictures come only when the
  page changes, one in flight until acked. Its JPEGs are BT.601 full range.
  Used until 0.2.4; it cost more than the page (below).
- `document.title` changed by a script fires no DevTools event: poll it.
- **A device scale factor below 1 works headless** (rootfs container,
  2026-11-06): `Emulation.setDeviceMetricsOverride` with 1790x638 and 0.75 /
  0.5 keeps `innerWidth` 1790 x 638 and gives `devicePixelRatio` 0.75 / 0.5;
  the screencast's JPEGs come at 1341x478 / 892x318 (Chromium's own
  rounding). Touches stay in CSS pixels. mgu-render's VIDEO op scales a
  smaller frame up (aspect kept, `GL_LINEAR`: mgu-store `gfx.c`
  `draw_video`).
- **On its Wayland backend into a compositor of our own (0.2.5,
  chromium-wl; off the car, 2026-11-06).** Debian's Chromium 156 runs with
  `--ozone-platform=wayland --kiosk` against a minimal compositor
  (wl_compositor, wl_subcompositor, wl_shm, xdg_wm_base, wl_output, wl_seat
  with no keymap): one full-screen toplevel, all of it in one shared-memory
  buffer per frame (no subsurfaces), committed only after the last frame
  callback, so answering callbacks no faster than N a second caps
  requestAnimationFrame at N. Its libwayland is built in (no
  `libwayland-client` NEEDED). Same animated page at 1790x638, 4 cores:
  headless + screencast 59 pictures/s for ~143 % of a core (browser process
  66 %, GPU process 65 %, renderer 12 %, before decoding the JPEGs);
  Wayland 62/s for ~29 %, libyuv's ARGBToJ420 0.5 ms a picture.
  - It refuses Vulkan on Wayland (`'--ozone-platform=wayland' is not
    compatible with Vulkan`): compositing is software; WebGL and WebGPU still
    run on ANGLE / Dawn over SwiftShader.
  - A browser window is **never narrower than 500 px** (configured 320 wide,
    it drew 500).
  - **In a window `Emulation.setDeviceMetricsOverride`'s `deviceScaleFactor`
    only changes `devicePixelRatio`**: the page is still drawn at 1 and cut
    off. With `scale` set to the same factor the 1790x638 CSS page is drawn
    into the smaller window; `Input.dispatchTouchEvent` then wants window
    pixels (CSS x scale). `--force-device-scale-factor` works too but needs a
    restart.
  - A title change draws nothing: after showing, a still page sends no new
    frame (chromium-wl keeps the last one from while hidden).
  - **Pointer lock needs the keyboard's focus** (0.2.6, 2026-11-07). Without
    a `wl_keyboard.enter` on the window, `document.hasFocus()` is false and
    `requestPointerLock()` rejects with `WrongDocumentError: The root
    document of this element is not valid for pointer lock` even after a
    tap (vel.gg on the car with 0.2.5); the `ACTIVATED` toplevel state alone
    is not enough. With the enter it locks (no `zwp_pointer_constraints_v1`
    offered). A `wl_keyboard.modifiers` after the enter, on a keyboard with
    `NO_KEYMAP`, **crashes Chromium**. A touch only counts as a user gesture
    at its end: a lock asked for in a touch's `pointerdown` is refused
    ("A user gesture is required"), in its `click` granted.
  - On the car (0.2.5, CPU mode, vel.gg's menu, 2026-11-07): chromium-wl
    3 ms a picture (the screencast's decode was 30 ms); the four cores 327 %
    busy: renderer 101 %, GPU process 61 %, chromium-wl 32 %.
  - In game (0.2.6, GPU mode, scale 0.5, ~5 pictures/s), by thread: the GPU
    process's main thread 82 % (Dawn's GLES backend, then ANGLE, then
    Mesa), vel.gg's main Web Worker 68 % and five more 10-24 %, the
    renderer's main thread 14 %, chromium-wl 3 %. The game runs in workers;
    the single busiest thread is WebGPU's translation to GL.
- **Game mode** (0.2.7): `--enable-dawn-features=skip_validation,disable_robustness`
  reaches Dawn in Chromium 156 (off the car, 2026-11-07, on SwiftShader): a
  buffer with `MAP_READ | MAP_WRITE` gives a validation error without it
  and none with it; a compute shader still gives the right numbers.
  Whether it saves time on the car's GPU process: not yet measured.
  - The GPU mode: Ozone Wayland has ANGLE ask for a **GBM platform display on
    Chromium's own GBM device** (made on the render node it finds with
    `drmGetDevices2`), or with **no device** when it finds none; Mesa's GBM
    platform without a device opens `/dev/dri/card0`. ANGLE's
    `FunctionsEGL::initialize` (main, 2026): Wayland platform only if built
    with ANGLE_USE_WAYLAND, then the "preferred" device display (needs
    `EGL_EXT_platform_device`, which Mesa 19 lacks), then
    `eglGetPlatformDisplayEXT` for surfaceless / GBM / Wayland types (each
    gated on its client extension), else `eglGetDisplay(native)`; a failure
    is "Failed to get system egl display". The shim maps surfaceless,
    Wayland, X11 and device-less GBM displays to its render-node GBM display.
    Chromium's frames then reach the compositor as GBM buffers over wl_drm
    (PRIME): **not yet seen on a GPU**.
- `--proxy-server` keeps loopback direct by default (`<-loopback>` would
  send it through the proxy).
- Without D-Bus Chromium logs a few dozen `dbus/bus.cc` errors at start:
  harmless.
- Run as a uid with no passwd entry and `--no-sandbox`, it works.
