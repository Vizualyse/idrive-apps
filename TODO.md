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

## Browser (vizualyse-chromium 0.2.0, vizualyse_chromium 0.2.0)

Chromium 156 with its own glibc, headless, WebGL and WebGPU on the CPU
(SwiftShader), its pictures through mgu-render in the app area, touch read
passively, only while parked
([`native/vizualyse-chromium`](native/vizualyse-chromium),
[knowledge/browser.md](knowledge/browser.md)). Built and tested off the car on
the unit's own root filesystem. **Ask before running anything on the unit.**
0.1.1's bundled Vulkan driver hung the kernel and blacked out the HMI
(2026-11-06): **never ship a GPU driver**; on the car its ICD is renamed
`intel_icd.json.off` by hand until the next install replaces the bundle.

- [ ] **0.2.0 on the car, CPU:** install, then read-only: `dmesg | grep
  'blocked for more'` says nothing, `gpu.json` says SwiftShader and JSPI ok,
  and https://webglreport.com/?v=2 shows WebGL 2 (software).
- [ ] **0.2.0 on the car, the GPU mode** (the unit's own Mesa 19 GLES through
  `gpu/egl_shim.c`; built and tested off the car up to opening the render
  node): turn it on from the iDrive page, browser hidden. Then the
  journal's `egl-shim:` lines and `gpu:` line, `gpu.txt`, `dmesg` (i915
  errors, blocked tasks), webglreport on the screen, and whether the HMI
  and CarPlay stay smooth under a WebGL page. Open: pbuffers on Mesa 19's
  gbm platform (ANGLE should use `EGL_KHR_surfaceless_context`); WebGPU
  through Dawn's GLES backend (compatibility mode).
- [ ] **On the car: touches under the browser.** Show should open the
  empty screen state first (the app's log: `screen state visible`; a
  `screen state: ... the browser goes over the main page` warning means the
  HMI didn't open it); touching the browser must press nothing of the HMI.
- [ ] **On the car:** scrolling by touch, the back arrow and a pop-up
  hiding it, the phone page, pages loading through
  the proxy, the pictures per second and the sink's ms (`status`), CPU and
  memory of Chromium (the cgroup's `memory.max_usage_in_bytes`).
- [ ] **Faster pictures:** the screencast is a JPEG round trip on the CPU.
  Next: Winston's globals (`xdg_wm_base`, `zwp_linux_dmabuf`; mgu-store's
  read-only `probe.js`) for Ozone/Wayland straight onto the screen, or a
  dmabuf handed to mgu-render.
- [ ] **Input:** the iDrive controller (FrontCCU) as arrow keys / scrolling,
  and the usbfs gamepads from Moonlight as the Gamepad API (Chromium has no
  evdev to read on the unit).
- [ ] **Sound:** `--mute-audio` for now; through SmartXbar as Moonlight does.

## Dropped

The old `stories/` (in git history before this file) also had a background
CarPlay test, auto mode for the mirror, the HMI pop-ups over the mirror, a
libva-based CarPlay feed and the grabber's encoder quality. The CarPlay second
screen replaces the mirror and avoids the pop-ups; whether it streams in the
background is the open protocol question above. Rotating the Cast phone link's
token was skipped.
