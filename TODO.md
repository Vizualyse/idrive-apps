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
hold-to-stop, Play / Stop / Quit game / Resume last, sound, the player gone
after a stop, the stream as uplink uid 12998, recmgr-whitelisted. **Never
stop or restart a hand-made unit on the car: recmgr restarts the head unit**
([knowledge/head-unit.md](knowledge/head-unit.md)).

- [ ] **Controllers on the car:** XInput USB pads are read through usbfs
  (no kernel drivers on the car, its README); passes off the car with a
  USB/IP virtual pad. Next: bump to 0.1.1, release, then on the car the
  Vader 4 Pro in a stream and the quit combo. Later: DualShock/DualSense
  over usbfs (HID reports), pads paired to the phone (Gamepad API).
- [ ] **The car's volume does nothing until a CarPlay phone connects:** the
  sound goes into SmartXbar's `CarPlayMain_CF_48_STEREO`, which the audio
  manager only makes a source (with the iDrive volume on it) while CarPlay
  is connected. Every 48 kHz stereo input in `SmartXMGU.bin` belongs to a
  projection (CarPlay, Android Auto, CarLife) except `IP_CF_48_STEREO`: find
  what that one is and how a source is activated (audiomanager over
  SOME/IP). OAP's "audioFocus" is only an app priority. Until then: the
  phone page's volume slider (0-150 %, live from 0.1.2).
  Lead: oap-sdk's OAP media player (`OapGenericMedia`,
  [knowledge/sound.md](knowledge/sound.md)).
- [ ] **The cluster and the HUD outputs** on the car (built, tested off the
  car only). The HUD shows black as transparent and runs at ~10 fps; the
  cluster's atlas wants full-range levels
  ([knowledge/cluster-and-hud.md](knowledge/cluster-and-hud.md)).

### Moonlight next: a real game is far slower than the desktop (2026-11-05)

With a game every frame changes and the stream runs at the full bitrate.
The Atom decodes in software in ffmpeg, the H.264 and every decoded frame
(1.38 MB at 720p) pass through Node, and nothing drops a late frame, so the
picture falls behind. Agreed order: **3 first, with hardware decoding**, plus
the smaller items; the counters (1) later. The ffmpeg decoder flags
(`-skip_loop_filter`, `-flags2 fast`) were turned down. One version bump for
the lot (`server.js` already has comment-only changes since 0.1.2).

- [ ] **Read-only on the car first (ask before running anything):**
  `ls -l /dev/dri /usr/lib/dri`, `ls /usr/lib*/ | grep -iE 'libva|mfx|igfx|iHD|i965'`,
  `ldd /usr/bin/winston-grabber` and `dasvideo`; mgu-store's
  `native/mgu-render/tools/car-test/probe.js gpu`. Copy `libmfxsw64`,
  `libmfxhw64-p.so.1.24`, `libva.so.1`, `libva-drm.so.1` off the unit for
  the off-car build and tests ([knowledge/video-decoding.md](knowledge/video-decoding.md)).
- [ ] **Decode in moonlight-core, on the GPU** (3): port upstream's
  `native/waze-on-cluster/src/decoder_msdk.cpp` (GPL-3.0, keep the
  attribution): VA display on `/dev/dri/renderD128` → MSDK
  (`MFX_IMPL_HARDWARE | VIA_VAAPI`), `AsyncDepth=1`, `DecodedOrder=1`, one
  decode unit per `DecodeFrameAsync` with `COMPLETE_FRAME`, a new session
  per sequence; VPP scales on the GPU to the output's size; `GPUCopy` if
  the CM runtime starts on the car.
  - moonlight-core mmaps the mgu-render frame file and writes each frame
    straight into the next slot (NV12 → I420 while copying, unless VPP at
    API 1.24 outputs YV12/I420), then slot, then seq. No ffmpeg process, no
    frames through Node; `dr_submit` decodes, so a late frame is replaced,
    never queued. The header's matrix/range words from the stream (Sunshine
    asks BT.601/709, limited/full: set `colorSpace`/`colorRange` in the
    stream config and write the same).
  - The cluster and the HUD: VPP scales to their size; the core hands the
    small I420 frames to `server.js` (a second frame file or the pipe) for
    the atlas, or packs the atlas itself.
  - Fallback when there's no `/dev/dri` or MSDK fails: libavcodec's
    software H.264 built into moonlight-core (as IterioDev's player is), same
    output path. Keep the stock ffmpeg only if that turns out simpler.
  - Build: link against stubs with the unit's SONAMEs (`libva.so.1`,
    `libva-drm.so.1`, `libmfxhw64.so`) and check imports, as upstream's
    `Makefile:241-280` / `tools/woc_abi.py`; the glibc 2.27 check as now.
  - Tests off the car: the firmware's `libmfxsw64` (software MSDK) in the
    Ubuntu 18.04 image against the real Sunshine; frames compared with
    ffmpeg's; a busy test pattern instead of the desktop.
  - `component.json`: `crashNames` for `moonlight-core` (a core dump
    otherwise restarts the unit), the `video` group if it ever stops being
    root.
- [ ] **The stop hint as an mgu-render overlay**, not burnt in: rasterise the
  text once to a premultiplied RGBA picture (IMAGE, ≤ 1024²), draw
  `[VIDEO][IMAGE]` for 10 s then `[VIDEO]` only (the renderer redraws the
  app's frame on every video frame). Drop the `subtitles` filter, the ASS
  file and the font's copy ([knowledge/central-screen.md](knowledge/central-screen.md)).
- [ ] **The output in the iDrive app:** a drop-down "Output: Centre
  console / Cluster / HUD" on the Moonlight page (`type="dropDownMenu"`,
  `on('action', ev => ev.row)`, `setValue('SelectedItem', i, 'UInt')`,
  upstream's Waze "Show on" as the model,
  [knowledge/idrive-app-ui.md](knowledge/idrive-app-ui.md)); a control
  socket command `output <console|map|hud>` in `control.js` that sets
  `settings.output` (the phone page keeps its own); greyed out while
  streaming, or it restarts the stream on the new output. Off-car test
  through the socket.
- [ ] **Bitrate and size defaults:** a default bitrate per mode (e.g. 5 Mbps
  at 720p30, 10 at 720p60) instead of 8 Mbps for all; 960x540 easy to pick.
  Until 3 lands: the core's stdout straight into ffmpeg's stdin
  (`stdio: ['pipe', ff.stdin, …]`), not through Node.
- [ ] **Pop-ups and calls:** when the Moonlight page loses focus while still
  visible (an HMI pop-up, a call) hide the full-screen picture, and show it
  again on focus ([knowledge/idrive-app-ui.md](knowledge/idrive-app-ui.md),
  "Visibility"). The reversing camera already hides it (mgu-render).
- [ ] **Only while parked:** the app reads `Vehicle2` speed (poll every 1-2 s;
  add it to the manifest) and tells the tool over the socket; the tool
  stops or refuses a stream above 3 km/h ([knowledge/vehicle-data.md](knowledge/vehicle-data.md)).
- [ ] **Check on the car:** the `…`, `—`, `·` in our RHMI texts (Unicode
  isn't reliable there); `nft list table inet mgu_uplink` (a final drop for
  new inbound on Wi-Fi, though the phone page works).
- [ ] **Later (1): where the time goes**, side by side every second: frames
  received by the core, frames decoded / written, CPU of each process; then
  the latency end to end.
- [ ] Touch claim: mgu-render's touch guard SIGKILLs the renderer after
  1.5 s without a heartbeat while touch is diverted, and teardown runs `nft`
  before the next beat: the likely cause of the two reboots
  ([knowledge/central-screen.md](knowledge/central-screen.md)). Raise it with
  mgu-render before claiming touch again.

## Chromium (a browser on the car's GPU)

Goal: WebGL/WebGPU pages running on the unit itself, e.g. a browser game
with streamed assets. The Atom A3960's GPU is an Intel HD 505 (Gen9), which
Mesa's iris/ANV drive with GL 4.6 and Vulkan on a normal kernel; the unit
has ~5.6 GB RAM in all and 9 GB free on `/var/opt` ([knowledge/head-unit.md](knowledge/head-unit.md)). Until it
works, streaming such a page from a PC through Moonlight does the job.

- [ ] **What the image has (read-only on the car):** `free -m` while the
  car runs, `df -h`, `/dev/dri` and its permissions, Mesa / `libvulkan` /
  `libEGL` / `libgbm`, and which process holds the GPU (the render service?).
  mgu-store's read-only `probe.js` (`globals`, `gpu`) answers most of it.
  Known from the reference repos: EGL/GLES2 (Mesa i915, dmabuf import),
  `libgbm.so.1`, Wayland + ivi-extension 1.11, no Vulkan named
  ([knowledge/video-decoding.md](knowledge/video-decoding.md)).
- [ ] **How a second client gets the GPU:** DRM render node (`renderD128`)
  next to the render service, or only through it (render to a dmabuf /
  shared buffer and hand frames over as a video layer). Leads: a native
  Winston (`wayland-0`) ivi client, as idrive7-apps' renderer does
  ([knowledge/head-unit.md](knowledge/head-unit.md)); check whether Winston
  has `xdg_wm_base` / `zwp_linux_dmabuf` for Ozone/Wayland.
- [ ] **A Chromium build for the unit:** Ozone headless/GBM, glibc and
  kernel 4.14 compatibility, bundling its own Mesa if the image has none;
  install size under `/var/opt`, a cap on its disk cache.
- [ ] **Memory:** a cgroup / limit so it can't starve the car's processes,
  and a Store unit recmgr won't restart the head unit over ([knowledge/head-unit.md](knowledge/head-unit.md)).
  cgroup v1 limits in the unit work (upstream's waze-on-cluster journal
  unit).
- [ ] **Input:** touch / iDrive controller and the usbfs gamepads from
  Moonlight, as the Gamepad API.

## Carried over

- [ ] **Rotate the Cast phone link's token** (0.3.8 works on the car; the
  token was readable by every Store app before it).


## Dropped

The old `stories/` (in git history before this file) also had a background
CarPlay test, auto mode for the mirror, the HMI pop-ups over the mirror, a
libva-based CarPlay feed and the grabber's encoder quality. The CarPlay second
screen replaces the mirror and avoids the pop-ups; whether it streams in the
background is the open protocol question above.
