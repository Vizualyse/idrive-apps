# TODO

What's left, roughly in order. Background: [`knowledge/`](knowledge/index.md);
the CarPlay second screen: [`re/STATUS.md`](re/STATUS.md).

Release rule: every change to what a component ships needs a version bump
(`node release/release.js bump <id> <x.y.z>`); publish with the Release
workflow (Actions > Release, the component ids).

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

## Moonlight (vizualyse-moonlight, vizualyse_moonlight 0.1.0)

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

## Browser (vizualyse-chromium 0.2.5, vizualyse_chromium 0.2.3)

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
- [ ] **0.2.5 on the car: pictures without JPEG.** Chromium on Wayland into
  chromium-wl, straight into the frame file (off the car ~5x less CPU per
  picture than 0.2.4's screencast). Check: `display: ready` in the journal,
  pages and vel.gg look right (colours, no tearing), `status` pictures per
  second and ms each, Chromium's CPU in `top`, the resolution setting (the
  page drawn scaled into a smaller window, touches scaled with it). **The GPU
  mode is new on this path and untested on a GPU**: Chromium hands its GBM
  buffers to chromium-wl over wl_drm, read back through the unit's EGL on
  the render node (the shim now also maps Wayland, surfaceless and
  device-less GBM displays to the render node, never card0). Try it by hand
  as before (gpu-trial marker), `dmesg` after. If it fails, frames may come
  as shared memory instead (software compositing): still no JPEG.
- [ ] **Faster GPU pictures:** chromium-wl reads each GPU frame back whole
  (glReadPixels, RGBA) and converts on the CPU; a shader to I420 first would
  read back 3/8 of it, and a dmabuf handed to mgu-render none.
- [ ] **Pointer lock for games** (vel.gg's start needs it): chromium-wl
  could offer `zwp_pointer_constraints_v1` / `zwp_relative_pointer_v1`, the
  touches driving relative motion.
- [ ] **Input:** the iDrive controller (FrontCCU) as arrow keys / scrolling,
  and the usbfs gamepads from Moonlight as the Gamepad API (Chromium has no
  evdev to read on the unit).
- [ ] **Sound:** `--mute-audio` for now; through SmartXbar as Moonlight does.

## Steam (vizualyse-steam 0.1.0, vizualyse_steam 0.1.0)

Windows games from the owner's Steam library through Proton (WineD3D on the
unit's own Mesa 19, Wine's Wayland driver into `wl-sink`, mgu-render's frame
file), downloaded with DepotDownloader (Steam Guard on the phone page),
played from the iDrive page or the phone, only while parked
([`native/vizualyse-steam`](native/vizualyse-steam),
[knowledge/games.md](knowledge/games.md)). Built and tested off the car on
the unit's own root filesystem (2026-11-06): download flow, Wine starting,
frames as PRIME buffers through the unit's i965 (stub), the right picture
(swrast), Stop. **Ask before running anything on the unit.**

- [ ] **Release** vizualyse-steam 0.1.0 and vizualyse_steam 0.1.0 (about
  410 MB to download, 1.3 GB unpacked), install from the Store, and read the
  journal: `bundle:` lines (the three archives unpacked), `dns:` (the phone's
  DNS). Then on the phone page: the account, Install Slay the Spire 2
  (2868840), Steam Guard; `steam:` lines, the download's progress.
- [ ] **On the car: the first game.** Play from the iDrive page:
  `wl-sink: ready ... GPU buffers`, `game: running`, the pictures per second
  and the sink's ms on the phone page, the picture in the app area. Then
  `dmesg | grep -iE 'i915|blocked for more'` (no GPU hang) and the memory
  (the cgroup's peak on the phone page). Whether Slay the Spire 2 starts
  without the Steam client (`SteamAPI_Init` fails here), and on
  `--rendering-driver opengl3`.
- [ ] **On the car: sound** through `pcm_play.py` into SmartXbar (the
  FIFO's bytes, the player's latency lines); the volume slider.
- [ ] **Input:** touch as the pointer (the display's PDUs, as the browser);
  `wl-sink`'s keyboard has no keymap yet (Wine logs "Failed to load Xkb
  keymap"). Without it a game can't be played, only started.
- [ ] **Controllers:** `t_xinput` with test/usbip_pad.c's virtual Vader 4
  Pro (as Moonlight's tests): Proton's winebus through SDL2 (built with
  hidapi on libusb, as the car has no evdev / HID / uinput), else an XInput
  DLL fed by Moonlight's `pads.c`.
- [ ] **32-bit D3D9 on `stub` exits 1 at teardown** after a full run
  (`wined3d_device_cleanup Context array not freed!`; 64-bit and `swrast`
  are fine).
- [ ] **Later:** Wine Mono for .NET Framework games (left out: 285 MB);
  where the CPU goes per picture (wl-sink reads each frame back and converts
  it to I420 on the CPU: a dmabuf handed to mgu-render would save that);
  a USB stick as the games' place (udisks2 mounts at `/media/<label>`).

## Dropped

The old `stories/` (in git history before this file) also had a background
CarPlay test, auto mode for the mirror, the HMI pop-ups over the mirror, a
libva-based CarPlay feed and the grabber's encoder quality. The CarPlay second
screen replaces the mirror and avoids the pop-ups; whether it streams in the
background is the open protocol question above. Rotating the Cast phone link's
token was skipped.
