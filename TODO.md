# TODO

What's left, roughly in order. Background: [`knowledge/`](knowledge/index.md);
the CarPlay second screen: [`re/STATUS.md`](re/STATUS.md).

Release rule: every change to what a component ships needs a version bump
(`node release/release.js bump <id> <x.y.z>`); publish with the Release
workflow (Actions > Release, the component ids).

## High priority

- [ ] **Winston output on the car** (Browser 0.2.9, Steam 0.1.8, Moonlight 0.2.3; built and
  tested off the car against the unit's own Winston, `tools/winston-bench`,
  [knowledge/central-screen.md](knowledge/central-screen.md) "Winston
  directly"). Release both, then on the phone page "Winston output" on, Show
  (by hand, never kept; **ask before running anything on the unit**). Read
  the journal: `display: ready ... Winston connected (dmabuf v1)`,
  `display: winston: on the screen`, no `relist: ... Permission denied`, and
  `screen: shown (winston)`. Check: the picture in the app area in full
  colour; the HMI's bar and back arrow still usable; a pop-up or the back
  arrow hides it; the reversing camera hides it (Winston's camera surfaces)
  and it comes back; an HMI scene change while shown (`layer taken off the
  screen, put back`). Browser GPU mode: `"fwd"` in chromium-wl's stats
  (Chromium's buffers passed on as they are) and a smooth WebGL page; the
  CPU of chromium-wl against mgu-render's path.
  Moonlight (centre console): `core: {"ev":"output","via":"winston",...}` in
  the journal; the picture with black bars and the stop hint for 10 s; the
  decoder event still `msdk (GPU, …)` with moonlight-core as uid 12998; the
  `decodeMs` and moonlight-core's CPU against mgu-render's path; hold-to-stop.
- [ ] **Winston output, next:** the default output once seen on the car,
  mgu-render's frame file only as the fallback. On the car with Steam:
  `"fwd"` in wl-sink's stats (Wine's GL area passed on as it is) and a game
  hidden and shown again a few times without stalling. Moonlight: MSDK
  decoding into VA surfaces exported as dmabufs, so the last copy goes too
  (the unit's libva is 1.x: `vaAcquireBufferHandle`, not
  `vaExportSurfaceHandle`).
- [ ] **Investigate Vulkan again**, with the safety net (by hand, the
  gpu-trial marker, an off-car harness first; see Browser's "Retry Vulkan
  (ANV)" below and [knowledge/browser.md](knowledge/browser.md), "Vulkan on
  this kernel"). It would give Proton DXVK / VKD3D in place of WineD3D and
  full WebGPU.
- [ ] **Investigate sound deeper: remove the CarPlay limitation.** The car's
  volume does nothing until a CarPlay phone connects (our sound goes into
  CarPlay's SmartXbar input; see Moonlight's item below and
  [knowledge/sound.md](knowledge/sound.md)): our own source and domain
  through the audio manager's routing interface, studied offline first.

## hook111 (CarPlay's second screen)

- [ ] **Load it with the Store's `preload`** (an LD_PRELOAD into a firmware
  process behind a strike guard, [knowledge/store.md](knowledge/store.md))
  instead of our own arming, if it fits `carplay`; upstream patches
  carplay 22.28.3 instead ([knowledge/carplay.md](knowledge/carplay.md)).
- [ ] **Cast on cluster-render 0.4.0** (upstream; we require 0.3.3): the
  `repeat` op, packed blocks, the HUD fixes
  ([knowledge/cluster-and-hud.md](knowledge/cluster-and-hud.md)).

- [ ] **On the car:** whether the phone draws the HUD size it is offered
  (1056x384), and how the cluster view looks at that shape.
- [ ] **On the car (still to test):**
  - the speed-limit sign (`showSpeedLimit=yes`) while driving on a road with
    a known limit (none showed parked on a residential street);
  - the native-size map while driving (packed frames when it moves fast?);
  - the built-in version of the above after the next release.
- [ ] **30 fps from Maps** (now ~16-17 fps): the iAP2 IdentificationInformation
  profile ID `bf889dfdaea54096` (`mapsRefreshRate=30`, luka-dev/mib2q-carplay-rgi
  `docs/altscreen-and-video/MAPS_30FPS_PROFILE.md`). Find where our `carplay`
  sends the identification (Cinemo's iAP2 stack), add the parameter in the
  harness first.
- [ ] **Open protocol questions:** what `primaryInputDevice` should contain.
- [ ] **Cast 0.3.8 on the car (2026-11-05):** centring and the time/distance
  card work; the **zoom controls do nothing** and the **directions card's
  on/off does nothing** (the card always shows). Changing many settings in a
  row can grey out the map while the cards stay (fixed by reconnecting the
  iPhone; maybe Google Maps itself).
- [ ] **HUD:** the text could be bigger (both views otherwise look fine).

## Moonlight (vizualyse-moonlight 0.2.2, vizualyse_moonlight 0.2.1)

Built and tested off the car against a real Sunshine
([`native/vizualyse-moonlight`](native/vizualyse-moonlight), "Off the car").
Installed from the Store on the car (2026-11-05): pairing over the hotspot,
a stream on the centre console (full screen, black bars, the stop hint),
the cluster and the HUD, hold-to-stop, USB pads (Vader 4 Pro), Play / Stop /
Quit game / Resume last, sound, the player gone after a stop, the stream as
uplink uid 12998, recmgr-whitelisted. **Never stop or restart a hand-made
unit on the car: recmgr restarts the head unit**
([knowledge/head-unit.md](knowledge/head-unit.md)).

- [ ] **The car's volume does nothing until a CarPlay phone connects:** the
  sound goes into SmartXbar's `CarPlayMain_CF_48_STEREO`, which the audio
  manager only makes a source (with the iDrive volume on it) while CarPlay
  is connected. Every 48 kHz stereo input in `SmartXMGU.bin` belongs to a
  projection (CarPlay, Android Auto, CarLife) except `IP_CF_48_STEREO`: find
  what that one is and how a source is activated (audiomanager over
  SOME/IP). OAP's "audioFocus" is only an app priority. Until then: the
  phone page's volume slider (0-150 %, live from 0.1.2).
  Tried on the car (2026-11-05, [knowledge/sound.md](knowledge/sound.md)):
  the Store apps' media source plays only finished files (no pipe, local
  HTTP or growing file); CarPlay's own process reports its sources
  unavailable without a phone, so a connect to them hangs; the owner slots
  nobody provides (CD, SDARS) have no source registered (coding). Left: our
  own source and domain through the routing interface (`registerDomain`,
  `registerSource`, `registerGateway`), studied offline first.

### Moonlight 0.2.0 on the car (built and tested off the car, 2026-11-05)

Decoding on the GPU in moonlight-core (no ffmpeg), the stop hint as an
mgu-render image, the Output drop-down, auto bitrate by size and rate, only
while parked (the app sends the speed). **Ask before running anything on the
unit.**

- [ ] **Release** vizualyse-moonlight 0.2.0 and vizualyse_moonlight 0.2.0,
  install from the Store, and read the journal: the core's `decoder` event
  should say `msdk (GPU, …)`; a `"fallback":true` one means the GPU failed
  (likely the MSDK session as uid 12998) and software took over. Then
  `stats`: `decodeMs`, `skipped`, `pps` with a real game at 720p60, and the
  CPU of moonlight-core (`top`).
- [ ] **Read-only on the car:** `ls -l /dev/dri`, `id` of the tool's
  process, and whether `igfxcmrt64` gets mapped (GPU copy: the decoder
  event says `GPU copy` or `CPU copy`).
- [ ] **The speed:** the app's log `speed: reading …` with the ignition on;
  a stream stops on driving off (or a test with the page's info).
- [ ] **The Output drop-down** on the iDrive page, and the stop hint's
  place and size on the screen.
- [ ] **Check on the car:** the `…`, `—`, `·` in our RHMI texts (Unicode
  isn't reliable there); `nft list table inet mgu_uplink` (a final drop for
  new inbound on Wi-Fi, though the phone page works).
- [ ] **Pop-ups and calls:** when the Moonlight page loses focus while still
  visible (an HMI pop-up, a call) hide the full-screen picture, and show it
  again on focus ([knowledge/idrive-app-ui.md](knowledge/idrive-app-ui.md),
  "Visibility"). The reversing camera already hides it (mgu-render).
- [ ] **Later: where the time goes**, side by side every second: frames
  received by the core, frames decoded / written, CPU of each process; then
  the latency end to end.

## Browser (vizualyse-chromium 0.2.8, vizualyse_chromium 0.2.5)

Chromium 156 with its own glibc, on its own Wayland compositor (chromium-wl), WebGL and WebGPU on the CPU
(SwiftShader) or, in the GPU mode, on the unit's own Mesa 19 (WebGL 2 on
the GPU seen on the car with 0.2.1, 2026-11-06), its pictures through mgu-render in the app area, touch read
passively, only while parked
([`native/vizualyse-chromium`](native/vizualyse-chromium),
[knowledge/browser.md](knowledge/browser.md)). Built and tested off the car on
the unit's own root filesystem. **Ask before running anything on the unit.**
0.1.1's bundled Vulkan driver hung the kernel and blacked out the HMI
(2026-11-06): **never ship a GPU driver known to hang the unit, nor any
without a safety net** (by hand only, a marker to fall back after a hang:
[knowledge/browser.md](knowledge/browser.md)); on the car its ICD is renamed
`intel_icd.json.off` by hand until the next install replaces the bundle.

- [ ] **0.2.2 on the car: WebGPU in the GPU mode** (compatibility mode on
  Dawn's GLES backend over ANGLE on Mesa 19: `--use-webgpu-adapter=opengles
  --force-webgpu-compat`; off the car on ANGLE / SwiftShader: `openGLES`,
  compatibility, the compute shader right). The journal's `gpu: WebGPU:`
  line should say `openGLES, compatibility mode, compute ok` without
  `software`; the app's GPU row `WebGPU: GLES compat`. Compatibility mode
  is reduced WebGPU: pages needing core features fail where the CPU mode
  runs them (slowly); maybe a per-page switch later. Also whether the HMI
  and CarPlay stay smooth with a WebGL / WebGPU page on the GPU.
- [ ] **0.2.4 on the car: memory.** vel.gg in the GPU mode at 2.5 GB
  (2026-11-06): 2547 of 2560 MB used, ~0.4 GB left on the unit, the HMI
  200 MB in swap, ~3 pictures/s, the CPU 92 % busy. With 0.2.4: Chromium's
  process count and PSS (the trimmed switches), `memory:` lines (asked to
  free memory near the cap), Make room (`room:` lines: Moonlight paused,
  Cast too if recmgr loaded it; both back after), then 3 GB, watching the
  HMI's swap (`VmSwap` of HmiMain3D) and `MemAvailable`.
- [ ] **The Store's updater daemon** (`mgu-updater` node, 237 MB on the car)
  is the biggest non-BMW memory user: ask upstream for a lighter idle mode
  rather than stopping it (it isn't ours).
- [ ] **A frames-per-second meter** in the status: how often the page draws
  (requestAnimationFrame) next to pictures reaching the screen, to tell a
  slow game from the picture path.
- [ ] **0.2.3 on the car: the resolution** (phone page or the app's
  Resolution button: full, 3/4 = 1340x476, 1/2 = 892x316, scaled up by
  mgu-render). How it looks, whether touches still land, and the gain on a
  heavy page on the CPU: chromium-wl's ms and pictures per second (`status`),
  Chromium's CPU in `top`, its memory peak.
- [ ] **On the car: touches under the browser.** Show should open the
  empty screen state first (the app's log: `screen state visible`; a
  `screen state: ... the browser goes over the main page` warning means the
  HMI didn't open it); touching the browser must press nothing of the HMI.
- [ ] **On the car:** scrolling by touch, the back arrow and a pop-up
  hiding it, the phone page, pages loading through
  the proxy, the pictures per second and chromium-wl's ms (`status`), CPU and
  memory of Chromium (the cgroup's `memory.max_usage_in_bytes`).
- [ ] **0.2.6 on the car: vel.gg starts.** 0.2.5 refused every pointer lock
  (vel.gg: "Mouse or sound access was declined: the root document of this
  element is not valid for pointer lock"): chromium-wl never gave the
  window the keyboard's focus, so Chromium's window had none. 0.2.6 sends
  `wl_keyboard.enter` (off the car: locked after a tap, unit_test). Check
  that vel.gg starts and plays by touch while locked; if it then wants
  relative motion from the touches, `zwp_pointer_constraints_v1` /
  `zwp_relative_pointer_v1` in chromium-wl. Sound is still `--mute-audio`.
- [ ] **0.2.7 on the car: game mode and 1/3, 1/4.** Game mode restarts
  Chromium with `--enable-dawn-features=skip_validation,disable_robustness`
  (off the car: the switch reaches Dawn, compute still right). In vel.gg,
  GPU mode, the same scale: pictures per second and the GPU process's main
  thread (82 % of a core without it, 2026-11-07), with and without; that
  the game still draws right; `dmesg` after (in the GPU mode a wrong command
  now reaches Mesa). Then 1/3 (596x212) and 1/4 (444x156): readable, the
  pictures per second, touches still landing.
- [ ] **Patch Chromium (a build of our own)** if game mode is not enough.
  On the car the busiest thread is the GPU process's main thread turning
  WebGPU into GL: Dawn's GLES backend, then ANGLE, then Mesa 19. Patch:
  Dawn's GLES backend straight on the unit's EGL / GLES (no ANGLE in
  between). With it, a build for the Atom (`-march=goldmont`) and without
  what the car doesn't use (memory, size). Needs a build machine (~100 GB,
  hours per build on many cores: not GitHub's free runners) and a rebuild
  for each Chromium security update; start from Debian's chromium source
  package and its patches, built in our Docker image as the bundle is now.
  Measure first what a patched GPU process would save (a CDP trace).
- [ ] **Retry Vulkan (ANV) for WebGPU**, with the safety net (by hand,
  the gpu-trial marker, never kept; an off-car harness first). Dawn on
  Vulkan would give full WebGPU (not compatibility mode) and skip the GL
  translation. Mesa 22.3's ANV hung the kernel (0.1.1), ≥ 23.2 refuses the
  4.14 kernel; the candidate is **ANV from Mesa 19.0.6**, the unit's own
  i965's release, built for the unit's glibc (knowledge/browser.md, "Vulkan
  on this kernel"). Chromium on Wayland refuses Vulkan for compositing only:
  Dawn (and ANGLE) can still use it.
- [ ] **vel.gg on the CPU, measured on the car with 0.2.5** (2026-11-07, on
  its menu, 30 s): chromium-wl's ms per picture 30 → 3 (the app), but the
  four cores 327 % of 400 busy, load 12.7: renderer 101 % (one core, the
  page's main thread), GPU process 61 % (SwiftShader), chromium-wl 32 %
  (more than 3 ms x 30/s: find where), node 23 %, natp 20 %, HmiMain3D 18 %.
  Memory: 42 MB free, 1.4 GB cache, 296 MB swap used; renderer 1.47 GB RSS,
  GPU process 0.55 GB. The renderer's core is the limit now: the GPU mode
  (WebGPU on GLES, below) is the next step, then the resolution.
  **In the GPU mode with 0.2.6** (2026-11-07, in game, Kino der Toten,
  ~46 s): ~1.6 pictures/s, chromium-wl 4.5-5.5 ms each and 3 % CPU; the
  cores only 216 % busy but load 16.7; renderer 106 % (its main thread
  pinned), browser process 50 %, GPU process 43 %, GPU clock 417 of
  450 MHz. Memory: Chromium 2.44 of its 3 GB cap, MemAvailable 0.5 GB,
  swap in use 768 MB (296 on the CPU run), the HMI 88 MB in swap. It
  flickered, and the GPU process died once at 12:16 ("GPU state invalid",
  exit 5; vel.gg: "Direct3D not available"), no GPU hang in dmesg. Next:
  find the flicker (chromium-wl's shm / drm counts in the journal), then
  less memory. **At scale 0.5** (892x316, same run): ~5 pictures/s (3x),
  chromium-wl 1.1-1.4 ms; renderer 174 %, GPU process 81 %, cores 238 %,
  load 11.6; memory unchanged (swap 794 MB). Next: a CDP trace of the
  renderer for a few seconds, to see whether the game's JS, WebGPU's
  command encoding or Blink takes its time, before any Chromium build of
  our own.
- [ ] **0.2.5 on the car: the GPU mode on the Wayland path.** The CPU mode
  works on the car (pictures, colours, 3 ms each). **The GPU
  mode is new on this path and untested on a GPU**: Chromium hands its GBM
  buffers to chromium-wl over wl_drm, read back through the unit's EGL on
  the render node (the shim now also maps Wayland, surfaceless and
  device-less GBM displays to the render node, never card0). Try it by hand
  as before (gpu-trial marker), `dmesg` after. If it fails, frames may come
  as shared memory instead (software compositing): still no JPEG.
- [ ] **Faster GPU pictures:** chromium-wl reads each GPU frame back whole
  (glReadPixels, RGBA) and converts on the CPU; a shader to I420 first would
  read back 3/8 of it, and a dmabuf handed to mgu-render none.
- [ ] **Input:** the iDrive controller (FrontCCU) as arrow keys / scrolling,
  and the usbfs gamepads from Moonlight as the Gamepad API (Chromium has no
  evdev to read on the unit).
- [ ] **Sound:** `--mute-audio` for now; through SmartXbar as Moonlight does.

## Steam (vizualyse-steam 0.1.7, vizualyse_steam 0.1.2)

Windows games from the owner's Steam library through Proton (WineD3D on the
unit's own Mesa 19, Wine's Wayland driver into `wl-sink`, mgu-render's frame
file), downloaded with DepotDownloader (Steam Guard on the phone page),
played from the iDrive page or the phone, only while parked
([`native/vizualyse-steam`](native/vizualyse-steam),
[knowledge/games.md](knowledge/games.md)). Built and tested off the car on
the unit's own root filesystem (2026-11-06): download flow, Wine starting,
frames as PRIME buffers through the unit's i965 (stub), the right picture
(swrast), Stop. **Ask before running anything on the unit.**

- [ ] **Small fixes:**
  - add an 1136x640 (or 1120x630) resolution and make it the default
    (now 1280x720, `src/server.js`); 960x540 stays the lighter choice, only
    slightly scaled up;
  - the 4:2:0 colour (I420) blurs small coloured text, which matters for
    UI-heavy games (FTL, card games): rendering through Winston (High
    priority) would avoid it.
- [ ] **On the car: the USB stick, what's left.** FTL (212680) installed
  onto the Kingston FAT32 stick with 0.1.1 (2026-11-07): sign-in approved in
  the Steam app, 199.5 MB downloaded (287 MB unpacked) in 2.5 minutes. Still
  to check: that the HMI's media player still sees the stick; pulling it
  during a game; a game with a file over 4 GB failing with the FAT32
  message.
- [ ] **Downloads to a stick are slow:** the stick wrote at about 4 MB/s
  while wlan0 brought about 4.3 MB/s and finished early. DepotDownloader
  pre-allocates every file, and FAT32 (no fallocate) writes zeros for that
  first, so each byte is written twice. Try exFAT (Tuxera texfat) and the
  hard disk for comparison; maybe show MB/s on the phone page.
- [ ] **On the car with 0.1.4:** FTL ran there with 0.1.3 (2026-11-07,
  32-bit through the rebuilt `ntdll.so`): shown, 15 pictures/s, GPU buffers,
  the sink's 34 ms a picture, no GPU errors. Now:
  - touch: a tap clicks where it lands (`touch: ready (reading)`), on FTL's
    menus;
  - no title bar (only the GL client area shown);
  - sound: the FIFO read at real time, `pcm:` lines with seconds played and
    little dropped (0.1.3 played 0.1 s in a minute: Wine wrote ~3.6x real
    time); the volume slider;
  - STS2 with Run without Steam on (gbe_fork): past "run the game from
    Steam";
  - no Wine Mono window (the kept prefix's updates disabled at start);
  - memory: FTL used 2.0 GB of the 2.5 GB cap (page cache in it?): read
    the cgroup's `memory.stat` while one runs.
- [ ] **Keyboard:** `wl-sink`'s keyboard has no keymap yet (Wine logs
  "Failed to load Xkb keymap"); an on-screen one, or the iDrive controller
  as keys.
- [ ] **On the car: a controller with 0.1.6.** The Vader 4 Pro (wired, an
  Xbox 360 pad `045e:028e`) in a game with controller support:
  `pads: player 1: ...` in the journal, its LED, the game's response.
  Off the car the unit test plays `t_xinput` through our `xinput1_4.dll`
  with the virtual USB/IP pad (A, the left stick).
- [ ] **Controllers, next:** rumble (XInputSetState into a file
  steam-pads sends to the pad's OUT endpoint); DualShock / DualSense over
  usbfs (HID reports; as Moonlight's TODO); vizualyse-moonlight onto the
  platform modules `native/pads` / `native/usb_pads` (it still has its own
  copy).
- [ ] **Try the "Should work" games** in
  [knowledge/game-compatibility.md](knowledge/game-compatibility.md)
  (Balatro first) and move each to Supported / Unsupported with the date
  and version; Unity games with `-force-glcore`, Godot 3 as is.
- [ ] **32-bit games, a long session:** threads come and go with an LDT
  entry each (`patches/wine-no-ia32.patch`), freed with the thread: watch a
  long FTL session for "too many threads".
- [ ] **32-bit D3D9 on `stub` exits 1 at teardown** after a full run
  (`wined3d_device_cleanup Context array not freed!`; 64-bit and `swrast`
  are fine).
- [ ] **Later:** Wine Mono for .NET Framework games (left out: 285 MB);
  where the CPU goes per picture (wl-sink reads each frame back and converts
  it to I420 on the CPU: a dmabuf handed to mgu-render would save that).

## Platform (platform/<side>/<module>/<version>)

The shared code as modules, each versioned on its own:
[platform/README.md](platform/README.md). Every module's 1.0.0 is a file
that was a byte-identical copy; Cast 0.3.9, Moonlight 0.2.2, Browser 0.2.8
and Steam 0.1.5 build from them; Steam 0.1.6 adds `native/pads`,
`native/usb_pads` and `native/usbip_pad` (its controllers).

- [ ] **On the car: Cast 0.3.9's sound.** Cast now plays through the
  platform's `pcm_play.py`, which makes the SmartX stream lock as the system
  does (Cast's own copy predated that fix). Play a stream URL with sound,
  then check CarPlay's own sound still works after it.
- [ ] **Merge the small forks into new modules** (measured 2026-11-07,
  whitespace and line ends ignored; they differ in names, ports and env
  prefixes, not logic):
  - `tool/control`: the four tools' `control.js` (19-25 lines apart, all
    socket path / env name / comment);
  - `tool/firewall`: four `firewall.js` (Chromium and Steam 12 lines
    apart; Moonlight's UDP host rule as an option);
  - `tool/proxy`: Cast's and Browser's `proxy.js` (the port only);
  - `tool/phone_page`: `token()`, `uplinkIp()`, `link()`, `readBody()`,
    `send()` / `json()` and `authorised()`, the same in all four
    `server.js` but for the token header's name. Security code: the token
    check and the firewall are worth having once;
  - `app/control_client`: the four `*_control.js` socket clients (connect,
    retry once a second, status / error events);
  - `app/build`: the four `tools/build.js` (the app id in a comment only);
  - `native/touch_main`: Browser's and Steam's `touch_main.c` (8 lines
    apart: the program's name);
  - the fake render client of the tools' tests (three copies, the env name).
- [ ] **Then the bigger pieces:** `tool/screen`, one mgu-render layer
  client and frame file from four (Cast's and Moonlight's
  `console_out.js`, Browser's and Steam's `screen.js`); `tool/unpack`
  (Steam's is Browser's plus links); the server scaffold (settings,
  on/off, command dispatch, shutdown, the speed gate), starting with
  Browser (fullest off-car suite); the apps' fake SDK / HMI from the four
  `test_page.js` (`OnlineApp`, `FakeComponent`, `startFakeTool`, `until`;
  the scenarios stay per app); the page base (`qrDir`, `oneRow`, QR row,
  button dedupe, the screen state that guards Show, focus loss: Browser's
  and Steam's app modules are mostly this); `make_page.js`'s writer.
- Not worth moving: `env.js`, `page.html`, `gamestream.js`, `usb.js`,
  `carplay_screen.js`, the decoders, `bundle.sh` and the Dockerfiles. Each
  is one app's own or has grown apart.
- [ ] **Last: one Wayland compositor** from `sink/wl.c` and `src/wl_sink.c`,
  only on the gpu-bench harness with a recovery path.
- [ ] **A scaffold** (`platform.js` or `new-app`): a tool and app pair from
  the next free port and uid, building and passing its tests.

## Dropped

The old `stories/` (in git history before this file) also had a background
CarPlay test, auto mode for the mirror, the HMI pop-ups over the mirror, a
libva-based CarPlay feed and the grabber's encoder quality. The CarPlay second
screen replaces the mirror and avoids the pop-ups; whether it streams in the
background is the open protocol question above. Rotating the Cast phone link's
token was skipped.
