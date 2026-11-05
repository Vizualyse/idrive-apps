# vizualyse-chromium

**Browser** for the iDrive 7 head unit: Chromium 156 running on the unit
itself, on its own GPU (the Atom A3960's Intel HD 505, Gen9), with **WebGL 2,
WebGPU and WebAssembly JSPI**, shown on the central screen while parked and
driven by touch. Addresses and text are typed on a phone page. Experimental:
built and tested off the car on the unit's own root filesystem (below), not
yet run on a car.

1. Install **Browser** (this tool) and the **Browser** iDrive app
   ([apps/vizualyse_chromium](../../apps/vizualyse_chromium)) from the Store.
   The first start unpacks Chromium (about 650 MB in `/var/opt`).
2. Open **Browser** on the iDrive. It says what the GPU gave Chromium:
   `WebGPU: intel / gen-9 | WebGL 2: Vulkan, Intel HD Graphics 505 (APL 3) |
   JSPI: ok` is the goal; `google / swiftshader (software)` means the GPU
   didn't work and Chromium fell back to its CPU renderer.
3. **Show on the screen**: the page (`https://webglreport.com/?v=2` at
   first) covers the app area; touch it as any page. The iDrive's back
   arrow on the left (or HOME, a pop-up, a call) hides it again.
4. Scan the QR code with the phone whose hotspot the car is on for the
   address bar, back / forward / reload, typing into the page, the GPU
   report (`chrome://gpu`) and a restart.

## Why it is built this way

From [knowledge/](../../knowledge/index.md), checked on the unit's root
filesystem (`../idrive-rootfs`):

- **No Vulkan on the unit**: Mesa 19.0.6 with the old `i965` GL driver only
  (`mesa-megadriver`), so no WebGPU from the system. glibc 2.27, the loader
  in `/lib` (no `/lib64`), no NSS or fontconfig. So the tool ships its own:
  Debian trixie's **Chromium** (BSD, open source) and **Mesa 25.0** (ANV for
  Vulkan, iris for GL), with **every library they load, glibc and its loader
  included** (`tools/bundle.sh`). `chromium` asks for the bundle's loader by
  absolute path; `LD_LIBRARY_PATH` is set only on its own exec (the unit's
  shell must keep its own glibc). Nothing from the unit's `/usr/lib` is
  loaded.
- **The kernel** is 4.14.147. Mesa 25's ANV needs softpin (4.5) and exec
  fence arrays (4.14) from i915, and emulates timeline fences when the kernel
  has none (`src/intel/vulkan/i915/anv_device.c`): it should start. Whether
  it does is the first thing to check on the car.
- **WebGPU on Gen9**: Chromium enables WebGPU on Linux only for newer Intel
  GPUs by itself, so `--enable-unsafe-webgpu`; ANGLE and Dawn both on Vulkan
  (`--use-angle=vulkan`, `--enable-features=Vulkan,...`). **JSPI** is on by
  default since Chromium 137; every start runs a real JSPI call
  (`WebAssembly.Suspending` / `promising`) to prove it.
- **Headless, through mgu-render**: Chromium can't own the display (Winston
  and the HMI do) and its Wayland backend needs `xdg_wm_base`, which Winston
  isn't known to offer. So it runs headless, renders on the GPU, and its
  **screencast** (JPEG per changed picture) goes through `chromium-sink`
  into mgu-render's I420 frame file, as Moonlight's video does. The CPU cost
  is the JPEG round trip, fine for pages, not yet for 60 fps games.
- **The app area, not the whole screen**: 1790x638 at +108+82 leaves the
  HMI's title bar and left strip (with its back arrow) uncovered, so the
  driver can always leave; the app hides the browser when its page loses
  visibility or focus (pop-ups, calls: knowledge/idrive-app-ui.md).
- **Touch read passively**: an AF_PACKET copy of the display's PDUs on
  vlan73 (Moonlight's decoder). Nothing is claimed: a touch claim through
  mgu-render restarted the unit twice. Touches that start outside the app
  area are left to the HMI.
- **Only while parked**: the app sends the speed (Vehicle2); above 3 km/h
  the browser hides and won't show.
- **Its own uid** 12997 (mgu-uplink routes only listed uids; root never
  gets the internet), group `video` for `/dev/dri/renderD128`, names
  resolved through the phone's DNS by `proxy.js` (the unit's resolver
  doesn't resolve internet names; Cast's proxy). **`--no-sandbox`**: the
  unit offers neither a setuid sandbox nor known user namespaces; the uid
  has no other rights.
- **Memory**: Chromium sits in its own cgroup v1 memory group capped at
  1536 MB (the unit has ~5.6 GB); its disk cache is capped at 100 MB.
- **Never a reboot**: the service is on recmgr's whitelist and `chromium`,
  `chrome_crashpad_handler` and `chromium-sink` on crashhandler's
  (component.json `recmgr`, `crashNames`); Chromium's own crashes restart
  only Chromium (5 times in 5 minutes at most).

## How it works

| Part | Runs as | Does |
|---|---|---|
| `server.js` | root | unpacks the bundle; starts / restarts Chromium; the phone page on port 8491 (token in the QR link); the iDrive app's socket; show / hide; the touch mapping; only while parked |
| `unpack.js` | root | `chromium.tgz` into `/var/opt/vizualyse-chromium/chromium`, once per bundle (sha256 stamp), streamed, then swapped in by rename |
| `browser.js` | - | Chromium over DevTools on a pipe: one tab at 1790x638, screencast, touches, text, keys, history; `probe()`: JSPI, WebGL 2, WebGPU (a compute shader) and `chrome://gpu`, on a local page (a secure context) |
| `chromium` | uid 12997, group video | headless, ANGLE and Dawn on ANV, in the memory cgroup, through the proxy |
| `chromium-sink` | root, then nobody | C (`sink/`): screencast JPEGs into the frame file's next slot as I420 (libjpeg-turbo, BT.601 full range); the display's touches as JSON lines |
| `screen.js` | root | the frame file `/dev/shm/mgu-video-vizualyse_chromium` and the mgu-render client in layer mode, in the app area |
| `proxy.js` | uid 12997 | HTTP / CONNECT on 127.0.0.1:8483, names through the phone's DNS |
| `control.js` | root | `/dev/shm/vizualyse-chromium/ctl.sock` for the app only: status; enable, disable, show, hide, home, reload, back, speed |
| `firewall.js` | root | the phone page's TCP 8491 on `wlan0`, in memory |

State in `/var/opt/vizualyse-chromium/state` (root): the token, the settings
(on / off, home page, last page), **`gpu.json`** and **`gpu.txt`** (the last
probe and `chrome://gpu`). The profile (cookies, cache, Mesa's shader cache)
is in `/var/opt/vizualyse-chromium/profile` (uid 12997). The journal has an
`@gpu {...}` line after each start.

## Off the car

- `sh build.sh` builds `build/chromium.tgz` in `image/Dockerfile` (Debian
  trixie from snapshot.debian.org at a fixed date, so two builds give the same
  bytes) and runs `sink/yuv_test.c` (the JPEG planes to I420 conversion).
  It refuses a bundle in which any ELF needs a library the bundle lacks.
- `sh test/run_unit_test.sh` runs both suites in a container made from the
  **unit's own root filesystem** (`../idrive-rootfs/20.40.2/rootfs.tar`:
  glibc 2.27, Node 8.16.2, the loader in `/lib`), no network, Chromium's
  SwiftShader standing in for ANV:
  - `test/unit_test.js`: the bundle unpacks (and isn't unpacked again);
    Chromium starts as uid 12997 / group 44; JSPI runs; WebGL 2 is on
    ANGLE/Vulkan; WebGPU has an adapter and a compute shader returns the
    right numbers; `chrome://gpu` is read; a page's screencast reaches the
    frame file with the right colours; a touch replayed from a capture
    presses a button.
  - `test/server_test.js`: `server.js` with a stand-in mgu-render client:
    the token, the probe and `@gpu`, `/api/go`, `show` places it in the app
    area and pictures arrive, a touch inside the area presses the page's
    button and one outside doesn't, 20 km/h hides it and refuses `show`,
    `hide` removes the frame file, `disable` / `enable`.
- What the bench can't tell: whether ANV and iris start on the unit's i915
  (kernel 4.14, the render node as group video), the frame rate the Atom
  manages, the memory a heavy page takes.

## On the car (first run)

Read-only, from the journal and the state folder (ask before anything
else on the unit):

- `journalctl -u vizualyse-chromium | grep -E '@gpu|chromium:|bundle:'`;
- `cat /var/opt/vizualyse-chromium/state/gpu.json` and `gpu.txt`
  (Graphics Feature Status, the Vulkan driver lines);
- then `https://webglreport.com/?v=2` on the screen.

If `gpu.json` says SwiftShader: `gpu.txt` and the journal's `chromium:`
lines say why (ANV's `kernel missing ...`, the render node's permissions).
`CHROMIUM_VK_ICD=swiftshader` (a drop-in) forces the software path.
