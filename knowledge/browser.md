# A browser on the unit (Chromium, WebGL, WebGPU)

What we found building vizualyse-chromium
([`native/vizualyse-chromium`](../native/vizualyse-chromium)). From the
rootfs copy of `I_21w12.2-1-4` (`../idrive-rootfs`) and its container
(2026-11-05), 0.1.0 and 0.1.1 on the car (2026-11-05, 2026-11-06). Index: [index.md](index.md).

## Never bring a GPU driver (the black screen, 2026-11-06)

- **0.1.1 with Mesa 22.3's ANV (Vulkan) blacked out the HMI and restarted
  the unit on every boot.** Chromium's GPU process hung in the kernel
  opening the GPU (`drm_open` → `i915_driver_open` → `i915_gem_open` →
  `i915_gem_context_open`, task in D state, unkillable), holding the DRM
  lock; the HMI's `viewmanager_Map`, `gvviewmanager_G` and `NmeVideoDevice`
  then blocked in `drm_stub_open` → `mutex_lock` ("blocked for more than 10
  seconds" in `dmesg`), nothing drew, and the unit restarted about a minute
  later. The tool starts Chromium at boot, so every boot did it again.
  Renaming the bundle's ICD (`intel_icd.json`) over SSH ended the loop.
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
- **Mesa 22.3's ANV** (Debian bookworm, `22.3.6-1+deb12u2`) has no such gate:
  it reads the param and, without it, makes constant buffer 0 relative
  (`anv_device.c:794, 963`). Its `libvulkan_intel.so` binds against trixie's
  newer libraries (checked with `RTLD_NOW`). **On the car it hung the
  kernel** (above): never again.
- With no Vulkan device, Chromium's GPU process exits on every start
  (`ANGLE Display::initialize ... Internal Vulkan error (-3)`), and Chromium
  turns WebGL off (webglreport: "supports WebGL but it is disabled or
  unavailable"); `--enable-unsafe-swiftshader` keeps WebGL on the CPU instead.
- Gen9 is ANV's (Gen8 went to `hasvk`).
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
- `document.title` changed by a script fires no DevTools event: poll it.
- `--proxy-server` keeps loopback direct by default (`<-loopback>` would
  send it through the proxy).
- Without D-Bus Chromium logs a few dozen `dbus/bus.cc` errors at start:
  harmless.
- Run as a uid with no passwd entry and `--no-sandbox`, it works.
