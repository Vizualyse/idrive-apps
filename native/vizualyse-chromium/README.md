# vizualyse-chromium

**Browser** for the iDrive 7 head unit: Chromium 156 running on the unit
itself, with **WebGL 2, WebGPU and WebAssembly JSPI**, shown on the central
screen while parked and driven by touch. Addresses and text are typed on a
phone page. **WebGL and WebGPU run on the CPU** (Chromium's SwiftShader);
since 0.2.0 an experimental **GPU mode**, turned on by hand, runs WebGL on
the unit's own GPU driver (below). Experimental: built and tested off the
car on the unit's own root filesystem (below).

1. Install **Browser** (this tool) and the **Browser** iDrive app
   ([apps/vizualyse_chromium](../../apps/vizualyse_chromium)) from the Store.
   The first start unpacks Chromium (about 420 MB in `/var/opt`).
2. Open **Browser** on the iDrive. It says what Chromium got:
   `WebGPU: CPU (SwiftShader) | WebGL 2: CPU (SwiftShader) | JSPI: ok`.
   **GPU mode** (the iDrive page or the phone page) restarts it on the GPU:
   `WebGL 2: GLES 3.2, Intel HD Graphics 505 (APL 3)` is the goal.
3. **Show on the screen**: the page (`https://webglreport.com/?v=2` at
   first) covers the app area; touch it as any page. The iDrive's back
   arrow on the left (or HOME, a pop-up, a call) hides it again. Under the
   browser the app shows an empty page, so touches on the browser press
   nothing of the HMI.
4. Scan the QR code with the phone whose hotspot the car is on for the
   address bar, back / forward / reload, typing into the page, the GPU
   report (`chrome://gpu`) and a restart.

## Why it is built this way

From [knowledge/](../../knowledge/index.md), checked on the unit's root
filesystem (`../idrive-rootfs`):

- **No Vulkan on the unit**: Mesa 19.0.6 with the old `i965` GL driver only
  (`mesa-megadriver`), so no WebGPU from the system. glibc 2.27, the loader
  in `/lib` (no `/lib64`), no NSS or fontconfig. So the tool ships its own:
  Debian trixie's **Chromium** (BSD, open source) with **every library it
  loads, glibc and its loader included** (`tools/bundle.sh`). `chromium`
  asks for the bundle's loader by absolute path; `LD_LIBRARY_PATH` is set
  only on its own exec (the unit's shell must keep its own glibc). Nothing
  from the unit's `/usr/lib` is loaded.
- **No GPU driver, and no access to the GPU.** 0.1.0 bundled Mesa 25's ANV
  (Vulkan), which refuses the unit's 4.14 kernel (no i915 context
  isolation). 0.1.1 bundled Mesa 22.3's ANV, which doesn't refuse it but
  **hung in the kernel opening the GPU** (`i915_gem_context_open`) while
  holding the DRM lock: the HMI's own view managers couldn't open the GPU,
  the screen went black and the unit restarted on every boot (2026-11-06,
  [knowledge/browser.md](../../knowledge/browser.md)). So since 0.1.2 the
  bundle has no Vulkan, DRI, GBM-backend or VA driver (`bundle.sh` refuses
  one) and Chromium runs **without the group `video`**, so it can't open
  `/dev/dri` even by mistake. WebGL 2 and WebGPU run on Chromium's own
  **SwiftShader** (`--enable-unsafe-swiftshader`), on the CPU.
- **The GPU mode (0.2.0, experimental): the unit's own driver.** Everything
  of ours that uses the GPU safely uses the unit's own userspace drivers
  (mgu-render: Mesa 19 EGL / GLES, `i965`). So the GPU mode runs ANGLE's
  GLES backend (`--use-gl=angle --use-angle=gles-egl`) on the unit's
  `/usr/lib/libEGL.so.1`, `libGLESv2`, `libgbm`, `libglapi` and
  `i965_dri.so`, linked from `/var/opt/vizualyse-chromium/gpu-libs` ahead
  of the bundle's libraries (`env.js`). The one piece of ours is
  `gpu/egl_shim.c`, a `libEGL.so.1` that turns ANGLE's
  `eglGetDisplay(EGL_DEFAULT_DISPLAY)` into a GBM display on the render node
  (`/dev/dri/renderD128`, group `video`): left alone, Mesa 19 would open
  `/dev/dri/card0`, the display Winston owns, and it has no surfaceless
  platform. It also **emulates pbuffers** (0.2.1): Chromium's offscreen
  surfaces need an EGL config with `EGL_PBUFFER_BIT`, and Mesa 19's GBM
  configs have window surfaces only (0.2.0 on the car: `No suitable EGL
  configs found`, the GPU process exited, back on the CPU). So window
  configs say pbuffer too, and each pbuffer is a GBM surface of its size
  with a window surface on it (never swapped, never shown);
  `gpu/egl_pbuffer_test.c` checks it against a stand-in Mesa
  (`gpu/fake_egl.c`) at every build. Everything else goes straight to
  Mesa. The bundle adds glibc's
  `libdl` / `libpthread` / `librt` stubs, without which the unit's 2.27 ones
  load into our 2.41 process and fail. Safety: **on by hand only** (the
  phone page or the iDrive app), **never kept** (every start of the tool is
  on the CPU, so a hang can't loop through boots), the `video` group only
  in this mode, back on the CPU by itself if the probe finds no GPU
  renderer or Chromium exits; `state/gpu-trial` marks a try in progress,
  and if the tool finds it at start (the unit restarted mid-try) the app
  says so. **WebGPU in the GPU mode (0.2.2)** runs on the same driver:
  Dawn's GLES backend over ANGLE (`--use-webgpu-adapter=opengles`; Linux
  leaves it off otherwise), which offers WebGPU's **compatibility mode**
  only, so `--force-webgpu-compat` gives it to every page, even one asking
  for plain WebGPU. Compatibility mode is reduced WebGPU (lower limits, no
  storage buffers in vertex shaders, no cube arrays): a page needing core
  features fails there and runs (slowly) in the CPU mode. Seen on the car
  with 0.2.1: WebGL 2 on `Mesa DRI Intel(R) HD Graphics 505 (Broxton),
  OpenGL ES 3.2`, compositing and canvas hardware accelerated.
- **Game mode (0.2.7, experimental)**: Chromium restarts with
  `--enable-dawn-features=skip_validation,disable_robustness`, so Dawn
  stops checking each WebGPU call and adding bounds checks to shaders. In
  vel.gg on the car (0.2.6, GPU mode) the GPU process's main thread, which
  runs Dawn and ANGLE, was the busiest thread (82 % of a core). A wrong
  command from the page is no longer caught (it can crash the GPU process
  or, in the GPU mode, reach the driver): trusted pages only. On by hand
  (phone page, app: `game`), never kept, like the GPU mode; in both the CPU
  and the GPU mode.
- **WebGPU**: `--enable-unsafe-webgpu` (Chromium's WebGPU allow-list);
  ANGLE and Dawn on Vulkan, which is SwiftShader (`--use-angle=vulkan`,
  `--enable-features=Vulkan,...`). **JSPI** is on by
  default since Chromium 137; every start runs a real JSPI call
  (`WebAssembly.Suspending` / `promising`) to prove it.
- **Its own display, through mgu-render (0.2.5)**: Chromium can't own the
  screen (Winston and the HMI do). It runs on its Wayland backend
  (`--ozone-platform=wayland --kiosk`) against **`chromium-wl`**, our own
  minimal compositor (`sink/wl.c`), which converts each frame straight into
  mgu-render's I420 frame file (libyuv), as Moonlight's video does. It
  answers Chromium's frame callbacks no faster than 30 a second while shown
  (5 while hidden), so Chromium never draws more than the screen takes. Until
  0.2.4 Chromium ran headless and its screencast JPEGs were encoded in the
  browser process and decoded again by `chromium-sink`: off the car, the same
  animated page at 1790x638 took ~143 % of a core for 59 pictures a second
  that way, ~29 % for 62 now (0.5 ms per conversion). On Wayland Chromium
  composites in software in the CPU mode (its Wayland backend refuses
  Vulkan); WebGL and WebGPU still run on SwiftShader.
- **Winston output (0.2.9, experimental)**: "Winston output" on the phone
  page (by hand, off again whenever the tool starts) shows the page straight
  on the centre screen instead, with no frame file and no mgu-render:
  chromium-wl is also a client of Winston, the unit's compositor (platform
  `native/winston_out`; connected at start while still root, keeping
  Winston's socket group after its drop to nobody). In the GPU mode
  Chromium's buffers go to Winston as they are (dmabufs, back to Chromium at
  Winston's release): no read-back and no I420, Winston's own GL draws them.
  Shared memory pictures are copied once into our own buffers, full colour.
  The same place (Winston fits a smaller resolution to it), hidden by Winston
  while the reversing camera shows, back on mgu-render by itself if the
  connection goes. Tested off the car against the unit's own Winston
  (`tools/winston-bench`; `test/run_winston_test.sh` runs the tool, Chromium
  and chromium-wl against it, pixels checked), not yet on the car.
- **The app area, not the whole screen**: 1790x638 at +108+82 leaves the
  HMI's title bar and left strip (with its back arrow) uncovered, so the
  driver can always leave; the app hides the browser when its page loses
  visibility or focus (pop-ups, calls: knowledge/idrive-app-ui.md).
- **The resolution (0.2.3; 1/3 and 1/4 since 0.2.7)**: full, 3/4, 1/2,
  1/3 or 1/4 (the phone page, the app's Resolution button; kept).
  Chromium's window is that much smaller (1340x476 / 892x316 / 596x212 /
  444x156, a multiple of 4; at 1/4 Chromium keeps its 500 px minimum width,
  the page in the left part, and chromium-wl crops) and the page is drawn scaled into
  it (`Emulation.setDeviceMetricsOverride` with `deviceScaleFactor` and
  `scale`: in a window, unlike headless, the scale factor alone doesn't draw
  smaller): the page keeps its 1790x638 CSS layout and sees
  `devicePixelRatio` 0.75 down to 0.25; touches are scaled into the window. The
  frame file is the window's size and mgu-render's VIDEO op fits it to the
  app area (aspect kept, linear filtering). Fewer pixels for SwiftShader to
  draw, smaller buffers, cheaper conversions. It changes live. (A Chromium
  window is never narrower than 500 pixels.)
- **Touch read passively**: an AF_PACKET copy of the display's PDUs on
  vlan73 (Moonlight's decoder). Nothing is claimed: a touch claim through
  mgu-render restarted the unit twice. Touches that start outside the app
  area are left to the HMI.
- **Only while parked**: the app sends the speed (Vehicle2); above 3 km/h
  the browser hides and won't show.
- **Its own uid** 12997 (mgu-uplink routes only listed uids; root never
  gets the internet), its own group (not `video`: no GPU), names
  resolved through the phone's DNS by `proxy.js` (the unit's resolver
  doesn't resolve internet names; Cast's proxy). **`--no-sandbox`**: the
  unit offers neither a setuid sandbox nor known user namespaces; the uid
  has no other rights.
- **Memory**: Chromium sits in its own cgroup v1 memory group, capped at
  1536 MB by default, 2, 2.5 or 3 GB from the phone page (the unit has
  ~5.6 GB; with a big game loaded ~0.4 GB was left and the HMI had 200 MB in
  zram swap: more for the browser means less for the HMI). At the cap the
  kernel ends one of Chromium's processes, never the HMI's; the tool reads
  that from `memory.oom_control` and says so (the app's status line, the
  phone page, `memory:` in the journal), as a big WebGPU game on the CPU did
  (its GPU process killed: the page loses its WebGPU device). Its disk
  cache is capped at 100 MB.
  - **Less of it (0.2.4)**, each switch checked in Chromium 156's source: no
    site isolation (`--disable-site-isolation-trials`: cross-site frames
    share the page's renderer; it protects a page from Spectre-style reads
    by another site's frames, little use with one page at a time),
    `--renderer-process-limit=2`, no spare renderer and no back-forward
    cache (`--disable-features=SpareRendererForSitePerProcess,BackForwardCache`),
    GPU tile and discardable caches capped
    (`--force-gpu-mem-available-mb=256`, `--force-gpu-mem-discardable-limit-mb=64`).
    Not `--enable-low-end-device-mode`: in the renderer it sets V8's
    `--optimize-for-size`, which slows games.
  - **Near the cap** (90 % of it, counting what the kernel can't simply drop:
    usage minus `total_inactive_file`) the tool asks Chromium to free what it
    can (DevTools `Memory.simulatePressureNotification`, critical: caches,
    decoded images, tiles, a GC), at most every 15 s.
  - **Make room** (the phone page, the app): the tool stops the Moonlight
    and Cast tools' services while the browser is on and starts them again
    when it goes off, the setting goes off or the tool stops (`room:` in the
    journal; `state/paused.json` with the boot). Only a unit recmgr loaded
    at this boot is stopped (`src/recmgr.js`, after mgu-deploy's
    `recmgrLoaded`: both list sections now and in the list as it stood at
    boot); stopping any other restarts the head unit. BMW's own services
    and the Store's are never touched.
- **Never a reboot**: the service is on recmgr's whitelist and `chromium`,
  `chrome_crashpad_handler`, `chromium-wl` and `chromium-touch` on crashhandler's
  (component.json `recmgr`, `crashNames`); Chromium's own crashes restart
  only Chromium (5 times in 5 minutes at most).

## How it works

| Part | Runs as | Does |
|---|---|---|
| `server.js` | root | unpacks the bundle; starts / restarts Chromium; the phone page on port 8491 (token in the QR link); the iDrive app's socket; show / hide; the touch mapping; only while parked |
| `unpack.js` | root | `chromium.tgz` into `/var/opt/vizualyse-chromium/chromium`, once per bundle (sha256 stamp), streamed, then swapped in by rename |
| `browser.js` | - | Chromium over DevTools on a pipe, and its display (`chromium-wl`): one tab at 1790x638, show / hide, touches, text, keys, history; `probe()`: JSPI, WebGL 2, WebGPU (a compute shader) and `chrome://gpu`, on a local page (a secure context) |
| `chromium` | uid 12997, group 12997 (GPU mode: group video, 44) | on its Wayland backend, into `chromium-wl`; ANGLE and Dawn on SwiftShader (the CPU), in the GPU mode ANGLE on the unit's Mesa 19 GLES; in the memory cgroup, through the proxy |
| `gpu/libEGL.so.1` | - | C (`gpu/egl_shim.c`), GPU mode only: the default, Wayland, surfaceless or device-less GBM EGL display becomes the unit's Mesa 19 on the render node through GBM |
| `chromium-wl` | root, then nobody in Chromium's group | C (`sink/wl.c`): Chromium's Wayland compositor, as long as Chromium runs (socket `/run/vizualyse-chromium/wayland-0`, 0660); each frame into the frame file's next slot as I420 (libyuv, BT.601 full range) while shown, paced to 30 a second; in the GPU mode Chromium's GBM buffers (wl_drm, PRIME) are read back through the unit's EGL |
| `chromium-touch` | root, then nobody | C (`sink/touch_main.c`), while shown: the display's touches as JSON lines |
| `screen.js` | root | the frame file `/dev/shm/mgu-video-vizualyse_chromium` (nobody's, for `chromium-wl`) and the mgu-render client in layer mode, in the app area |
| `proxy.js` | uid 12997 | HTTP / CONNECT on 127.0.0.1:8483, names through the phone's DNS |
| `control.js` | root | `/dev/shm/vizualyse-chromium/ctl.sock` for the app only: status; enable, disable, show, hide, home, reload, back, gpu, speed |
| `firewall.js` | root | the phone page's TCP 8491 on `wlan0`, in memory |

State in `/var/opt/vizualyse-chromium/state` (root): the token, the settings
(on / off, home page, last page), **`gpu.json`** and **`gpu.txt`** (the last
probe and `chrome://gpu`; `gpu.json` says `"mode":"gpu"` or `"cpu"`), and
**`gpu-trial`** while a GPU-mode Chromium runs. The profile (cookies, cache)
is in `/var/opt/vizualyse-chromium/profile` (uid 12997). The journal has an
`@gpu {...}` line after each start.

## Off the car

- `sh build.sh` builds `build/chromium.tgz` in `image/Dockerfile` (Debian
  trixie from snapshot.debian.org at a fixed date, so two builds give the same
  bytes).
  It refuses a bundle in which any ELF needs a library the bundle lacks.
- `sh test/run_unit_test.sh` runs both suites in a container made from the
  **unit's own root filesystem** (`../idrive-rootfs/20.40.2/rootfs.tar`:
  glibc 2.27, Node 8.16.2, the loader in `/lib`), no network, Chromium's
  on SwiftShader as on the car:
  - `test/unit_test.js`: the bundle unpacks (and isn't unpacked again);
    Chromium starts as uid 12997 / group 12997; JSPI runs; WebGL 2 is on
    ANGLE/Vulkan; WebGPU has an adapter and a compute shader returns the
    right numbers; `chrome://gpu` is read; `chromium-wl` runs as nobody
    with a 0660 socket; shown, the page's pictures reach the frame file with
    the right colours, hidden none; at scale 0.5 the window and pictures are
    half size and a tap still lands; a touch replayed from a capture presses
    a button. The GPU mode's plumbing: `gpu-libs`; `egl_shim_test`
    (built next to the bundle, not shipped) finds the shim, the unit's Mesa
    19 libEGL behind it (`eglInitialize`, `eglGetPlatformDisplayEXT`, GLES
    entry points through libglapi), only the render node tried, and the
    unit's `i965_dri.so` binding in our process; Chromium in the GPU mode
    loads the unit's libEGL through the shim and, with no GPU, falls back to
    SwiftShader.
  - `test/server_test.js`: `server.js` with a stand-in mgu-render client:
    the token, the probe and `@gpu`, `/api/go`, `show` places it in the app
    area and pictures arrive, a touch inside the area presses the page's
    button and one outside doesn't, 20 km/h hides it and refuses `show`,
    `hide` removes the frame file; the GPU mode: off at start, a leftover
    `gpu-trial` reported, `gpu` on restarts Chromium through the shim and
    goes back to the CPU by itself; `disable` / `enable`.
- What the bench can't tell: anything about the unit's GPU and kernel (the
  container has neither: 0.1.1's hang was only seen on the car), so whether
  the GPU mode renders; the frame rate the Atom manages, the memory a heavy
  page takes.

## On the car

Read-only, from the journal and the state folder (ask before anything
else on the unit):

- `journalctl -u vizualyse-chromium | grep -E '@gpu|chromium:|bundle:'`;
- `cat /var/opt/vizualyse-chromium/state/gpu.json` and `gpu.txt`;
- `dmesg | grep 'blocked for more'` must say nothing;
- then `https://webglreport.com/?v=2` on the screen.

The GPU mode, the first time: turn it on from the iDrive page with the
browser hidden; the journal's `egl-shim:` lines (`display: GBM on
/dev/dri/renderD128`), `gpu: WebGL 2 on the GPU: ...` or why not, and
`dmesg` for i915 errors or blocked tasks afterwards. If the screen freezes,
the unit restarts on the CPU (the mode is never kept).
