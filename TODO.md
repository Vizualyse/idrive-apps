# TODO

What's left, roughly in order. Background: [`knowledge/`](knowledge/index.md);
the CarPlay second screen: [`re/STATUS.md`](re/STATUS.md).

Release rule: every change to what a component ships needs a version bump
(`node release/release.js bump <id> <x.y.z>`); publish with the Release
workflow (Actions > Release, the component ids).

## High priority

- [ ] **The car list for game performance (Steam 0.1.14, 2026-11-08).**
  Each step asked first; the journal read right after a run (the unit keeps
  only 10-15 minutes of the tool's lines), not polled during. The day's
  findings: knowledge/game-compatibility.md and knowledge/games.md.
  Done on the car 2026-11-08: a game starts, shows, hides, perf lines (0.1.11);
  FSR and its live switching on Vampire Survivors (about 10 ms GPU a
  picture); Detail Lite / Potato start there (no more Detail runs wanted);
  the app's Upscaling button; 0.1.12's tap deadzone and swap file seen;
  **32-bit DXVK on ANV 19.1.8 through vk-trial** (t_d3d932 / t_d3d1132 and
  the 64-bit pair, pixels checked, no GPU hang): 0.1.14 ships 19.1.8.
  Done 2026-11-09 on 0.1.14: Don't Starve on Vulkan (about 20 pictures/s,
  smooth with a pad; taps still miss); Vampire Survivors fine on 19.1.8;
  Slay the Spire 2's FSR runs (about 21/s at 8 ms GPU, wl-sink 0.6 ms a
  picture), its enemy-turn hang the same on 19.1.8, its OpenGL renderer
  broken (both in knowledge/game-compatibility.md). Next:
  1. Vulkan 1.3: patched ANV 22.3.7 restarted the unit at `enumerate`
     (2026-11-09; knowledge/browser.md): its context GETPARAM 0x7 (`SSEU`
     upstream) is answered by the unit's kernel and the close then waits on
     `struct_mutex` for ever. Patched (no context param after 6:
     `mesa-ctx-params-max-6.patch`): **every gate stage ok on the car**
     (enumerate to present), and DXVK 2.6.2's programs, 64- and 32-bit,
     pixels right. Next: 22.3.7 as a choice in the Steam tool (planned
     first: a build and a release), then Slay the Spire 2's
     enemy turn on it (if Mesa 19's shader compiler is the hang, 22.3's
     gets past it).
  2. iris: the gated try passed on the car (2026-11-09, `tools/iris-bench/car`;
     knowledge/games.md). Next: WineD3D games on iris in the Steam tool
     (a 32-bit OpenGL path faster than i965?), and the HMI's look during it.
- [ ] **Steam 0.1.15 (off the car first):** Wine Mono back (GE-Proton's
  11.3.0 with FNA, 276 MB unpacked, about 220 without its `.dbg` files:
  Terraria and the XNA games); Wine's screen at least 640x480 for older
  engines (Teslagrad's Unity 4 refused 896x320); taps held at least ~150 ms,
  longer at a low frame rate (Don't Starve at 2.5 fps missed them); gbe_fork
  for 2013-era SDKs (Teslagrad: `STEAMUNIFIEDMESSAGES_INTERFACE_VERSION001`
  through `GetISteamController`); SteamStub (`.bind`) spotted at install and
  said on the phone page (Castle Crashers); perf lines kept in the tool's
  own file. From 2026-11-09: taps still miss in Don't Starve at 20 pictures/s
  (they reach it: a tap drops the pad's focus), so the hold matters at any
  rate; Godot's `opengl3` on Mesa 19 (Slay the Spire 2's Vulkan off) fails
  its scene shader (`packHalf2x16` in `#version 330`, no
  `ARB_shading_language_packing` enabled): try `force_glsl_extensions_warn=true`
  in Godot games' environment on the bench; the phone page's per-game
  switches (Run without Steam, Detail, Vulkan) take but only show after a
  reload (a few releases now), and its FSR size says 0x0 after a hide/show.

- [ ] **Winston output on the car** (Browser 0.2.9, Steam 0.1.8, Moonlight 0.2.3; built and
  tested off the car against the unit's own Winston, `tools/winston-bench`,
  [knowledge/central-screen.md](knowledge/central-screen.md) "Winston
  directly"). Release both, then on the phone page "Winston output" on, Show
  (by hand, never kept; **ask before running anything on the unit**). Read
  the journal: `display: ready ... Winston connected (dmabuf v1)`,
  `display: winston: on the screen`, no `relist: ... Permission denied`, and
  `screen: shown (winston)`. **Browser 0.2.9 seen on the car (2026-11-07,
  vel.gg Kino der Toten, GPU mode + game mode + Winston output):** all four
  journal lines as above (`surface 0x565a0100 on layer 0x565a0000 at
  108,82 1790x638`), the game played on the screen. CPU over ~14 s in game
  (from `/proc`, one SSH read): **chromium-wl ~0 % and Winston 0.2 %**
  (chromium-wl was 32 % through mgu-render, CPU mode, 0.2.5), but the unit
  still **97 % busy** of 4 cores: renderer 158 % (compositor thread 38 %,
  the game's main worker 30 %, five more workers 9-13 % each), **browser
  process 80 % (main thread 66 %: new, find out why: Wayland buffer
  hand-offs or the DevTools pipe?)**, GPU process 65 % (main thread 59 %,
  82 % on 0.2.6 without game mode), HMI 12 %. **At 1/2 (892x316) 99 %
  busy**: compositor 29 %, browser main 50 %, GPU main 53 %, but the game's
  main worker up to 44 %: the CPU is the limit, not pixels. No pictures per
  second yet (the fps meter below). Seen once: at the restart for game mode
  the first chromium-wl failed `unable to lock lockfile
  /run/vizualyse-chromium/wayland-0.lock` (the old one not gone yet), the
  next start was fine. Still to check: the picture in full colour; the
  HMI's bar and back arrow still usable; a pop-up or the back arrow hides
  it; the reversing camera hides it (Winston's camera surfaces) and it
  comes back; an HMI scene change while shown (`layer taken off the
  screen, put back`); `"fwd"` in chromium-wl's stats; CPU mode through
  Winston.
  Moonlight (centre console): `core: {"ev":"output","via":"winston",...}` in
  the journal; the picture with black bars and the stop hint for 10 s; the
  decoder event still `msdk (GPU, …)` with moonlight-core as uid 12998; the
  `decodeMs` and moonlight-core's CPU against mgu-render's path; hold-to-stop.
- [ ] **Winston output, next:** now the default in Browser 0.2.10, Steam
  0.1.9 and Moonlight 0.2.5 (mgu-render as the phone page's "Compatibility
  mode"). On the car with Steam:
  `"fwd"` in wl-sink's stats (Wine's GL area passed on as it is) and a game
  hidden and shown again a few times without stalling. Moonlight: MSDK
  decoding into VA surfaces exported as dmabufs, so the last copy goes too
  (the unit's libva is 1.x: `vaAcquireBufferHandle`, not
  `vaExportSurfaceHandle`).
- [ ] **Winston only, once 0.2.10 / 0.1.9 / 0.2.5 have been used a while:** remove the
  other centre-screen paths and keep Winston output alone. Browser:
  chromium-wl's I420 frame file and GPU read-back (`sink/wl.c`, libyuv);
  Steam: wl-sink's read-back and frame file; Moonlight and Cast:
  `console_out.js`'s mgu-render layer and the I420 copy; the platform's
  `native/frame_out`; the "Winston output" switches (always on) and the
  fall back to mgu-render when Winston's connection goes (decide what
  replaces it: retry, or hide). Keep cluster-render (Winston can't reach
  the cluster or the HUD). Then drop mgu-render from each tool's
  `requires` and the knowledge files' "through mgu-render" lines.
- [ ] **Vulkan in Steam 0.1.9 on the car:** ANV 19.0.6, the loader and
  DXVK 1.9.4 now ship in Steam (`vulkan.tgz`, `tools/vulkan.sh`); Vulkan is
  the default for 64-bit games (the exe's PE header), off for 32-bit ones,
  switchable per game, off again after any unclean end (the running marker
  left at a restart). Seen on the car before the release (2026-11-08, hand-
  patched 0.1.8): STS2 (Godot 4, `--rendering-driver vulkan`, Forward+)
  plays, fights smooth. Check with 0.1.9: STS2 with no launch options
  (Godot's opengl3 swapped for vulkan by the tool), no hang over a long
  session, `state/vulkan-crumbs.log` written. 32-bit stays on WineD3D: see
  Steam's "32-bit games on Vulkan" below. VKD3D (D3D12) needs much more
  than ANV 19. After a hang: `state/vulkan-crumbs.log` (the ioctl that never
  returned); for new drivers, `tools/vk-trial` first (gated, one start).
- [ ] **Game performance, on the car (Steam 0.1.10, Cast 0.3.11, Browser
  0.2.11 / app 0.2.6, vizualyse-bus 0.1.0; built and tested off the car
  2026-11-08):** then with a real game (**ask before running anything on the unit**; read the journal
  after, don't poll during):
  - the default Picture 960x540 (a unit that had 1280x720 saved moves to it
    once), the 848x480 / 640x360 choices on the phone page;
  - frames held to 30: wl-sink's `commits` per second in the journal's
    stats, WineD3D (`vblank_mode=3`) and DXVK (`dxvk.conf`); a GL game's
    look and input lag with the swap interval forced to 1;
  - DXVK games report HD Graphics 510 / 1024 MB (`dxvk.conf`): a game that
    picks its preset from it (and none that refuses the adapter);
  - `scaled` in wl-sink's stats for a game at a mode the screen lacks; STS2
    (Godot) `fwd` now, or still read back ([knowledge/games.md](knowledge/games.md));
  - the bus: `systemctl status vizualyse-bus`; Cast's CarPlay second screen
    on the cluster pauses while a game runs and comes back after it;
    `bus:` lines in both tools' journals. Steam and the Browser: a game
    pauses the browser (and it comes back after); game mode turned on
    during a game stops the game; Make room gone from the app and page.
  Measured since (the user's test, 2026-11-08): the CPU limit has mostly
  gone; games are now GPU / memory bound. Next: "Game performance, next".
- [ ] **Game performance, next (GPU / memory bound; plan of 2026-11-08):**
  1. **FSR on the car (Steam 0.1.11, app 0.1.3; built and tested off the
     car 2026-11-08, [knowledge/games.md](knowledge/games.md) "FSR in
     wl-sink"):** ask before running anything on the unit; read the
     journal and the status after, don't poll during. One GPU-bound game,
     Winston output on, at Picture 896x320 then 1120x400:
     - Upscaling off, then FSR, then FSR without sharpening (the phone
       page or the iDrive button, mid-game), a minute or two each in the
       same scene; then stop the game and read `journalctl -u
       vizualyse-steam | grep perf:` (the summary per mode: fps, 1 % and
       0.1 % lows, p99 and worst frame time, FSR's GPU time and skips, the
       GPU's busy share and clock, the CPU's and the game's CPU, the game's
       memory, available memory and swap);
     - FSR's GPU time (guess 3-8 ms), `fsrSize` 1792x640 (or 1790x638),
       skips near 0: keep FSR only if the lows and the worst frame hold
       against off and it looks better than Winston's bilinear at the same
       Picture;
     - the HUD / text legibility at 896x320 with each, a photo of the
       screen for the record;
     - nothing new in `dmesg` (i915) after it; no "fsr:" line in the
       journal (FSR turning itself off).
     If it costs too much: EASU alone (`fsr-soft`), or a cheaper EASU
     (fewer taps, as mobile ports do).
  2. **32-bit games** (Steam's "32-bit games on Vulkan" and "32-bit games,
     a long session" below), before any of what follows.
  3. **Then DXVK 2.x by a newer ANV** (bench done 2026-11-08, branch
     `steam-mesa`: [knowledge/games.md](knowledge/games.md) "Vulkan",
     [knowledge/browser.md](knowledge/browser.md) "Vulkan on this kernel").
     On the car, each step asked first, the gate's recovery known (a hang:
     the marker, `arm --again`; Steam untouched), crumbs + `sysrq w`:
     - **ANV 19.1.8 + DXVK 1.10.3** first (Steam's "32-bit games on
       Vulkan" item has its steps): 19.3.5 is no better for DXVK 1.x and
       sends `I915_QUERY` (ioctl 0x39 = `GEM_GVTBUFFER` on the unit).
     - **ANV 22.3.7, patched (no `I915_QUERY`) + DXVK 2.6.2**:
       `MESA_VER=22.3.7 sh tools/vk-trial/build.sh`, the stages one start
       each (instance .. present; present now through `wl-sink --dmabuf`),
       then `MESA_VER=22.3.7 DXVK_VER=2.6.2 sh tools/vk-trial/dxvk/package.sh`
       and run.js with `t_d3d1164.exe t_d3d964.exe t_d3d1132.exe
       t_d3d932.exe`. The same ANV hung the car unpatched in 0.1.1: if
       this one runs, `I915_QUERY` was very likely the cause (record it).
       Off the car: `MESA_VER=22.3.7 DXVK_VER=2.6.2 DXVK_PROGRAMS="t_d3d1164.exe
       t_d3d964.exe t_d3d1132.exe t_d3d932.exe" sh tools/vk-trial/dxvk/car_test.sh`
       passed (2026-11-08: the four programs ok, result=ok, no GPU hang or
       blocked tasks on the stub, 33 s).
     - If both hold: a candidate Steam bundle,
       `STEAM_MESA_VER=22.3.7 STEAM_DXVK_VER=2.6.2 sh tools/vulkan.sh`
       (game.js gives wl-sink `--dmabuf` by `lib/mesa`), one game on it, its
       perf lines against 19.0.6 + 1.9.4.
     - Bench, still to do (low: 22.3.7 already gives Vulkan 1.3 and DXVK
       2.6.2): 23.1.9 doesn't build with Ubuntu 18.04's GCC 7 (its C++:
       "non-trivial designated initializers not supported",
       `brw_simd_selection.cpp`; run alone 2026-11-08): `g++-8` (18.04's
       universe) with `-static-libstdc++` in `anv_new.sh` (the unit's
       libstdc++ is older); why DXVK 2.3.1 loses its device after 10 frames
       (2.6.2 is fine); 23.2+ only with `8a1a49aae40` reverted (sketch in
       browser.md).
  4. **Detail Lite / Potato on the car (Steam 0.1.11, built and tested
     off the car 2026-11-08):** per game on the phone page (Options):
     DXVK's MSAA / tessellation / feature level 10_1 / 512 MB, WineD3D's
     `WINE_D3D_CONFIG` (shader model 2 seen applied on the stub), engine
     presets (Unity `-screen-quality`, Unreal `-ExecCmds` scalability,
     Source convars). With one game each on DXVK and on WineD3D (and a
     Unity one: Teslagrad is Unity 4, now recognised): normal, Lite,
     Potato, each a few minutes in the same scene, then the journal's
     `perf: summary` lines compared (fps and lows, GPU busy, the game's
     memory); and whether it starts at all on Potato (feature level 10_1
     and shader model 2 stop some games: note which). The `detail:` line
     in the journal says what was applied. Later, with DXVK 2.x:
     `samplerLodBias` (lower texture detail: memory bandwidth); the
     game's own render scale (keeps its HUD sharp) where an engine has
     one we can set from outside.
  5. **Later:** iris 19.3 (bench 2026-11-08, [tools/iris-bench](tools/iris-bench/README.md),
     [knowledge/games.md](knowledge/games.md) "iris / Gallium Nine"):
     patched for the unit's kernel (no CS_DEBUG_MODE2 / CS_CHICKEN1, no
     I915_QUERY), WineD3D 64 / 32-bit on it on the stub, GL 4.6, wl-sink
     on the unit's i965 importing its buffers. Car: one gated try like
     vk-trial's (iris's own EGL set, gpu-bench's gltest, then t_d3d9 in
     Wine; `dmesg` for i915 errors and the HMI drawing right during and
     after, the picture's colours through wl-sink), and only then a
     per-game "OpenGL: iris" switch in Steam. Gallium Nine
     dropped: its only Wine front end presents through X11, and 32-bit
     would need a new WoW64 front end and below-4 GB mappings in Gallium.
     Frame generation (lsfg-vk 2.0 needs Vulkan 1.2 and costs GPU we lack).
- [ ] **Investigate sound deeper: remove the CarPlay limitation.** The car's
  volume does nothing until a CarPlay phone connects (our sound goes into
  CarPlay's SmartXbar input; see Moonlight's item below and
  [knowledge/sound.md](knowledge/sound.md)): our own source and domain
  through the audio manager's routing interface, studied offline first.

## Emulator (tools/mgu-emu)

The unit boots in QEMU to the HMI's home screen in English, with stand-ins
for the car's SOME/IP services (carsim); a click is a touch on the centre
screen, the arrow keys / Enter / Backspace the iDrive controller; mgu-store
installs and the updater installs apps (ours too) through the uplink
([tools/mgu-emu](tools/mgu-emu/README.md), "The Store", "The controller").

- [ ] **HmiTest answers nothing**: what gates
  `CHmiStubHmiTest::sendCommand` (try again since the policy fix).
- [ ] **The Store's touch:** mgu-render's nft rule fails to load
  (`Could not process rule: No such file or directory`, "touch stays the
  HMI's"); the controller keys work meanwhile. Likely an nftables module
  the VM's kernel lacks (`tools/mgu-emu/kernel`).
- [ ] **Our tools in the emulator:** vizualyse-chromium 0.2.10 and
  vizualyse-moonlight 0.2.5 (with cluster-render 0.4.2 from upstream's
  source) install through the updater from our fork, start after a restart
  and pass mgu-deploy's health check (Chromium: "Unable to get gpu
  adapter"); opening and using them on the screen is untested. Not tried:
  vizualyse-steam (large download),
  vizualyse-cast. The build's `updater.local.conf` seed is untested on a
  fresh disk.
- [ ] **Old `vizualyse_*` apps in our catalog:** the `releases` channel
  lists cast 0.3.6, chromium 0.2.5, moonlight 0.2.1, steam 0.1.2 as apps
  (tags `vizualyse_*@...`, 2026-11-07) beside the tools: delete those
  releases or keep them out of the catalog.
- [ ] **Name the controller's buttons:** button 2 is BACK; the keycodes of
  the others (README "The controller") are guesses under lag.

## hook111 (CarPlay's second screen)

- [ ] **Load it with the Store's `preload`** (an LD_PRELOAD into a firmware
  process behind a strike guard, [knowledge/store.md](knowledge/store.md))
  instead of our own arming, if it fits `carplay`; upstream patches
  carplay 22.28.3 instead ([knowledge/carplay.md](knowledge/carplay.md)).
- [ ] **cluster-render 0.4.2 on the car:** Cast 0.3.10 and Moonlight 0.2.4
  now require it (was 0.3.3; its protocol only added fields since, so our
  client is unchanged). Release both, then the CarPlay map's pictures per
  second against 0.3.3's ~14.5 of 20 (936x480, parked), and the HUD's
  (0.4's own cap is ~10/s, Cast asks 15). **No take-over test** until the
  BC-press hazard is understood
  ([knowledge/cluster-and-hud.md](knowledge/cluster-and-hud.md)). Next:
  send `repeat` for an unchanged frame (when the service's `hello` has
  `repeat` 1), and crop the map's dimmed bands (y 0-72, 440-480).

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
  free memory near the cap), then 3 GB, watching the
  HMI's swap (`VmSwap` of HmiMain3D) and `MemAvailable`.
- [ ] **The Store's updater daemon** (`mgu-updater` node, 237 MB on the car)
  is the biggest non-BMW memory user: ask upstream for a lighter idle mode
  rather than stopping it (it isn't ours).
- [ ] **A frames-per-second meter** in the status: how often the page draws
  (requestAnimationFrame) next to pictures reaching the screen, to tell a
  slow game from the picture path. Needed now: the Winston run (above) has
  CPU figures but no pictures per second; log a count once a second from
  chromium-wl's Winston path too, so a session is read after it, not polled.
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
- [ ] **Retry Vulkan (ANV) for WebGPU**, once
  [tools/vk-trial](tools/vk-trial/README.md) has seen Mesa 19.0.6's ANV
  get through `compute` on the car (High priority): then Chromium as a
  vk-trial `command` stage, never kept. Dawn on Vulkan would give full
  WebGPU (not compatibility mode) and skip the GL translation. Mesa 22.3's
  ANV hung the kernel once (0.1.1, cause unknown), ≥ 23.2 refuses the 4.14
  kernel by a check we could revert (untried). Chromium on
  Wayland refuses Vulkan for compositing only: Dawn (and ANGLE) can still
  use it. Chromium's bundled loader would need ANV for glibc 2.27 (ours)
  or its own build.
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
- [ ] **32-bit games on Vulkan: needs ANV 19.1.8** (found on the bench
  2026-11-08, [knowledge/games.md](knowledge/games.md) "Vulkan": 19.0.6 has
  no `VK_EXT_external_memory_host`, so WoW64 can't map GPU memory below
  4 GB). Branch `steam-32bit`: vk-trial builds either (`MESA_VER`), Steam
  still pins 19.0.6. On the car, each step asked first, read the logs
  after (no polling during):
  1. Read-only: `zcat /proc/config.gz | grep -E "MMU_NOTIFIER|DRM_I915_USERPTR"`
     (if the unit has it): 32-bit DXVK's memory goes through
     `I915_GEM_USERPTR`, which vk-trial's stages never used; 4.14 needs
     `CONFIG_MMU_NOTIFIER` for it.
  2. `MESA_VER=19.1.8 sh tools/vk-trial/build.sh` and `dxvk/package.sh`,
     both onto the car, then the 32-bit try through the gate
     (`tools/vk-trial/README.md`, "The 32-bit try": `run.js run t_d3d932.exe
     t_d3d1132.exe t_d3d1164.exe t_d3d964.exe`). Read `out.log`, `result`,
     `crumbs.log` (`USERPTR` lines). If it hangs: the gate's marker, `hung`
     at the next boot, `arm --again` wanted; the last `>` crumb without its
     `<` is the call; Steam itself untouched (19.0.6).
  3. If it passes: Steam with 19.1.8 (`tools/vulkan.sh`'s pin, `VERSION`,
     server.js's "ANV 19.0.6" log line), Vulkan allowed for 32-bit games
     (`vulkanDefault`: x64 only now), released, then Teslagrad (below).
- [ ] **`t_d3d964` sometimes hangs to run.js's 150 s timeout** off the car
  (twice in ~20 runs of vk-trial's DXVK tests, once on ANV 19.0.6 and once
  on 19.1.8, both run after `t_d3d1164` in the same go): not the driver.
  Not caught with logs yet; next time keep the whole `car_test.sh` output
  (run.js prints the program's Wine errors) and its `.wine.log`.
- [ ] **Teslagrad on the car (249590; Unity 4, 2013, 32-bit, D3D9):**
  1. `pidof dotnet` (read-only; a DepotDownloader left from the stalled try,
     pid 28447 then): if there is one, ask before killing it.
  2. Download with "Download from" Amsterdam (or Frankfurt), not
     Automatic (London's certificates). If it stalls again, note
     DepotDownloader's last lines (journal) and stop: `-depot` by default is
     the CDN item below.
  3. On WineD3D (Vulkan off, today's default for 32-bit): it starts, draws,
     touch / pad work. Unity 4 may open its resolution dialog first (a Win32
     dialog: tap Play). Options to try: `-screen-width 960 -screen-height 540
     -screen-fullscreen 1`; `-force-opengl` (Unity 4's own GL renderer,
     WineD3D out of the way). Unity 4 has no `-force-glcore`. Its log:
     `Teslagrad_Data/output_log.txt` (Unity version, renderer).
  4. On DXVK, only after the vk-trial try above passed and Steam has
     19.1.8: Vulkan on for it, the same checks; frame times from wl-sink's
     stats against WineD3D's.
  Then `vulkan-crumbs.log` and the journal, once, after.
- [ ] **Steam's CDN in London serves the wrong certificates** (lhr1
  servers, 2026-11-08; DNS the same over the phone and 8.8.8.8; Amsterdam
  and Frankfurt fine). The phone page's "Download from" region (`-cellid`)
  helps for content, not manifests. Seen working: `-depot` with the game's
  own depot (Gunpoint, 507 MB), skipping Steamworks Common Redistributables
  (app 228980). Make that the default (the game's depots only), and retry
  a stuck download with another region. Teslagrad's download (depot
  249591) stalled; a DepotDownloader may still be running on the car (pid
  28447): check `pidof dotnet` before the next download.
- [ ] **wl-sink's "fwd" doesn't engage for Godot's Vulkan surface** (STS2:
  0 fwd, read back at ~109 ms a picture); DXVK's test passes 120 fwd. Find
  why (buffer format or modifier?) on the bench.
- [ ] **STS2 memory:** the cgroup at 2862 of 3072 MB, 2.7 GB of swap, the
  HMI with 270 MB swapped out during a run. Try 960x540 and Godot's Mobile
  renderer (`--rendering-method mobile` chose D3D12: needs the Vulkan driver
  forced with it).
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

Pinning the GPU's clock for games (`gt_min_freq_mhz` raised to the maximum)
was considered on 2026-11-08 and not taken up: more heat and power on a GPU
the HMI shares.
