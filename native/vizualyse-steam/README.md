# vizualyse-steam

**Steam** for the iDrive 7 head unit: Windows games from your Steam library
running on the unit itself through **Proton** (GE-Proton 11, Wine), drawn
on the unit's own GPU driver and shown on the central screen while parked,
with sound. Sign in and install games on a phone page; play them from the
iDrive or the phone. Experimental: built and tested off the car on the
unit's own root filesystem (below); **nothing has run on the car yet.**
Background: [knowledge/games.md](../../knowledge/games.md).

**Not in this version:** a keyboard; controllers other than wired XInput
(Xbox 360-style) USB pads, and their rumble (touch is the mouse: a tap
clicks, a drag moves with the button held); .NET Framework games (no Wine
Mono). Games that need the Steam client running (it doesn't
run here) get **Run without Steam** per game (gbe_fork, below), and games
wrapped in Steam's DRM **Remove Steam DRM** (SteamStub, below). 64-bit and
32-bit games run on the car (Slay the Spire 2, FTL; 32-bit through our
rebuilt `ntdll.so`, below).

1. Install **Steam** (this tool) and the **Steam** iDrive app
   ([apps/vizualyse_steam](../../apps/vizualyse_steam)) from the Store. The
   first start unpacks Proton, its runtime and a Windows prefix (about
   1.3 GB in `/var/opt`, a few minutes; the app says so).
2. Open **Steam** on the iDrive: it opens on its touch screen (below).
   Scan the QR code (Settings) with the phone whose
   hotspot the car is on. On the phone page: your Steam **account name**,
   then **Install** with the game's app id (the number in its store
   address; **Slay the Spire 2** has a button: 2868840). Steam asks for the
   password and a Steam Guard code (or approval in the Steam app) right on
   the page, once: the car keeps only Steam's sign-in token.
3. When it is installed, tap its tile on the touch screen: its **start
   menu** opens (its picture size, upscaling, memory, Detail, frames,
   Vulkan, Remove Steam DRM: kept for the game, below), then **Play** there
   (or **Play: <game>** on the iDrive list, or Play on the phone). Starting
   takes a while (Wine, then the game); the game shows by itself once it
   draws. The
   back arrow on the left (or HOME, a pop-up, a call) hides it; it keeps
   running until **Stop the game**.

## The touch screen

The app opens the tool's **touch screen** when it is opened, built from the
platform's touch kit (`tool/touch_ui`, shared by every app's touch screen):
its empty screen state, then `{"cmd":"ui","on":true}`. The **List** button
(top right) hides it and sends the app `{"ev":"list"}`: the app goes back to
its iDrive list. It shows parked or driving (since 0.3.1); above 3 km/h
(the speed the app sends) only the game's picture hides, Show and Play are
refused until parked, and the touch screen comes back in its place.

- **The screen** (`src/touch_view.js`): two tabs in the kit's frame.
  *Library*: the running (or last) game's card (`Running · 28 pictures/s`,
  its name, **Show on the screen**, **Stop the game**), the download with a
  progress bar, and the games as tiles (their picture or plate, their name
  and their profile in a line, `960 × 540 · FSR · Vulkan`, or Running now,
  `(no program found)`, `(USB stick not plugged in)`, Downloading), four a
  page with < > buttons, never scrolling. *Settings*: the Steam client,
  Steam on / off, and the phone page's link as a QR code (the platform's
  `common/qrcode`, made once a link).
- **A game's start menu (0.4.0)**: a tile opens it; to 0.3.2 a tap played
  the game, and the picture's size, upscaling, frames and memory were the
  tool's, for every game. Its own two tabs take the place of Library and
  Settings: *Picture* (the shape, 16:9 or the screen's, and the size, a
  drop-down of that shape's five; memory for the game; Upscaling Off / FSR /
  FSR without sharpening; Detail Normal / Lite / Potato; 30 or 60 frames a
  second) and *How it runs* (Vulkan, OpenGL on iris, Remove Steam DRM, Run
  without Steam, and Reset to the defaults: everything but the two switches
  that change the game's files). Above them its card: the back arrow, its
  picture, name and profile in a line, and **Play**, or **Show** and
  **Stop** while it runs. Play is greyed with the reason (another game
  running, moving, no program, the stick out). A game played here goes on
  the screen by itself once it draws, if the touch screen is still up; the
  menu stays open under it. Each choice is kept in the game's
  `library.json` entry at once (the profile: `resolution`, `fps`, `upscale`,
  `memMb` beside `detail`, `vulkan`, `iris`, `noDrm`, `noSteam`); upscaling
  and the memory cap change the running game at once, the rest its next
  start. The phone page has the same per game (Options). Updating from
  0.3.2, the tool's own picture, frames, upscaling and memory settings
  become each installed game's, once, and are gone; a new game starts from
  the defaults (960x540, 30, off, 2.5 GB). The iDrive app's **Picture** and
  **Upscaling** buttons cycle the running (or last played) game's.
- **One picture at a time** (`src/touch_screen.js`): the app's screen
  state holds the touch screen or the game, each its own mgu-render client
  (`vizualyse_steam_ui`, `vizualyse_steam`), never both connected. Showing
  the game (from the touch screen, the app or the phone) hides the touch
  screen first; when the game's picture goes (it stops, ends, is hidden, or
  the car moves) the touch screen comes back while the app's state is open
  (`uiWanted` in the status). `{"cmd":"ui","on":false}` and the List button
  end that.
- **The picture** (the kit: `ui_host.js`, `ui_kit.js`, `ui_canvas.js`): one
  opaque RGBX pixmap the size of mgu-render's app area (1790x638 at
  +108+82); only the rectangles that changed are drawn and sent, at most a
  frame every 33 ms. Its model comes from memory only (the settings, the
  library, the game's and the download's state; the USB sticks and the
  phone page's link as last read, every 3 s and 10 s).
- **Touch** (`touch_reader.py`, mgu-python, from the kit): the display's
  touch PDUs read passively, as `steam-touch` reads them for the game; one
  of the two readers runs at a time.

## Why it is built this way

- **Proton with WineD3D on OpenGL** (`PROTON_USE_WINED3D=1`), or Vulkan:
  Direct3D 9 to 11 become OpenGL on the unit's own **Mesa 19 i965**
  (desktop GL 4.5 core), the driver the HMI uses, or for a game on Vulkan
  (the default for 64-bit games) **DXVK 2.6.2 on Mesa 22.3.7's ANV**
  (Vulkan 1.3; 0.2.0: 19.1.8 and DXVK 1.9.4 before), from `vulkan.tgz`.
  The unit's kernel is IOTG 4.14: ANV is patched to send nothing it
  doesn't know (no `I915_QUERY`, no context param after 6: one hung it,
  knowledge/browser.md). A GPU driver of ours only after it passed
  `tools/vk-trial`'s gate on the car (the browser's 0.1.1 hung the kernel
  with an unchecked one); `runtime.tgz` carries none (`tools/bundle.sh`
  refuses one), and iris for OpenGL is a choice per game (below).
  A Vulkan game's DRM calls are watched by `vk_crumbs.so`
  (`state/vulkan-crumbs.log`, opened `O_DSYNC`): each process's first 400
  lines written as they happen (the driver starting), then a call only
  when it hasn't come back in a second, with the calls before it: after a
  hang, the last `! not back after` line is the call. (To 0.2.3 every call
  was written as it happened, 16 synchronous writes a frame at the least:
  on the bench it held a game with nothing to draw to 20 frames a second;
  0.2.4, knowledge/games.md.) Wine's own lines go to the journal a message
  five times, then counted (`src/wine_log.js`, 0.2.4: WineD3D on iris wrote
  one 8.7 million times in 45 s on the bench).
- **Wine's Wayland driver into wl-sink**: the unit's EGL has no X11, and the
  screen belongs to Winston and the HMI. `wl-sink` (`src/wl_sink.c`) is the
  smallest compositor Wine takes; Mesa's Wayland EGL hands it each frame as a
  **PRIME buffer** (`wl_drm`), which it imports on the GPU and writes into
  mgu-render's frame file (I420), shown in the app area (1790x638 at
  +108+82), aspect kept. The game draws at the **Picture** size (960x540 by
  default since 0.1.10, 1280x720 before; a 16:9 picture is shown at 1134x638,
  so more than that is drawn for nothing; 1344x480 is the screen's shape).
  Wine puts a Direct3D / OpenGL
  game's client area in a subsurface over its window frame (title bar
  included, drawn in software): wl-sink shows only that client area, so
  there is no title bar (a plain window shows whole; `--whole-window`).
- **Winston output (0.1.8, experimental)**: "Winston output" on the phone
  page (by hand, off again whenever the tool starts) shows the picture
  straight on the centre screen instead: wl-sink is also a client of
  Winston, the unit's compositor (platform `native/winston_out`, connected
  at start while still root; it keeps Winston's socket group after its
  drop), and hands it the composed picture in full colour, no I420. Same
  place, fitted by Winston; hidden by Winston while the reversing camera
  shows; back on mgu-render by itself if the connection goes. Wine's GPU
  buffers go to Winston as they are (no read-back, no copy), since 0.1.10
  also when Wine scales them with a viewport (a game at a display mode the
  screen doesn't have: Winston scales, `wo_present_view`). Tested off the
  car against the unit's own Winston (`tools/winston-bench`).
- **Nothing drawn that isn't shown (0.1.10):** the game draws at most at the
  tool's frame rate (30 by default). WineD3D / OpenGL: Proton's Wine asks for
  swap interval 0, and `vblank_mode=3` makes Mesa 19's EGL take at least 1,
  so each swap waits for wl-sink's frame callback (bench: 29 frames a second
  from a test program that asks for no vsync). DXVK: `dxvk.conf` in the run
  folder while a Vulkan game runs (`env.dxvkConf`): vsync on whatever the
  game asks (0.2.4), so wl-sink's frame callback holds it too; DXVK's own
  `maxFrameRate` only as a stop at twice the rate (as the limit itself, to
  0.2.3, it waited each frame's end out at full speed: its `dxvk-queue`
  thread took 18-28 % of a core on the bench); one frame queued, two shader
  compilers, no anisotropic filtering, and the adapter WineD3D reports (HD
  Graphics 510, 8086:1902, 1024 MB) so games pick their settings the same
  on both. wl-sink's ticks are at fixed times (0.2.4): 30.0 a second, where a
  tick set 33 ms after the last one ended gave 28 (and 17-22 when wl-sink
  put pictures together on the CPU).
- **Upscaling (0.1.11, experimental):** a game drawn smaller than it is shown
  is enlarged by Winston (bilinear, free) or, with **Upscaling: FSR** (the
  game's start menu or its Options on the phone page, or the iDrive app's
  button; at once, off by default; each game's own from 0.4.0), by AMD's FSR 1
  in wl-sink (`src/fsr.c`: EASU, then RCAS sharpening, two GLES 3 passes on
  the unit's i965): the game's buffer, while it would be passed on as it is,
  is drawn at its size on the screen into one of three GPU buffers of
  wl-sink's, which Winston shows 1:1; the game's own buffer goes back to Wine
  at once instead of waiting on Winston. Only when Winston would scale by 10 %
  or more. A window a little larger than the picture (Godot's full screen
  one, 898x320 at -1,0 on 896x320) is trimmed to it, for FSR and for the
  plain pass-on alike (0.1.13; before, it went through the CPU, 8-18 ms a
  picture, and FSR never ran). On the car it costs about 10 ms of GPU a
  picture (7.7 without sharpening). From 960x540 (shown at 1134x638) it barely does, so it goes with the
  screen-shaped Pictures 1120x400, **896x320** (2x) and 672x240. Its GPU time
  per picture (timer queries) is in the status (`game.fsr.gpuMs`) and on the
  phone page. It enlarges the HUD and text too; a game's own render scale
  keeps those sharp. Off the car: `test/run_fsr_test.sh` (the shaders on the
  unit's i965 compiler; pixels on llvmpipe, against bilinear).
- **Detail (0.1.11, per game, experimental):** the game's start menu, or
  Options on the phone page,
  Normal / Lite / Potato, from the game's next start, on top of its own
  settings and launch options (never saved into them). Lite: MSAA off and
  tessellation capped (DXVK: `d3d11.disableMsaa`, `d3d9.forceSwapchainMSAA`,
  `maxTessFactor 8`; WineD3D: `WINE_D3D_CONFIG` without multisample
  textures or hull / domain shaders) and the engine's own low settings
  (`steam.detailArgs`: Unity `-screen-quality Fast`, Unreal `-ExecCmds` with
  scalability groups at 0, Source convars). Potato: also Direct3D 11 at
  feature level 10_1, tessellation 1, 512 MB reported (DXVK); shader model 2
  for Direct3D 9 and 512 MB (WineD3D); Unity `Fastest`, more Unreal and
  Source groups. Some games refuse Potato: then Lite. The journal's
  `detail:` line names what was applied.
- **Performance in the journal (0.1.11):** `perf:` lines (`src/perf.js`)
  every 10 s, at each change of upscaling and as a summary per mode when the
  game ends: fps, the 1 % and 0.1 % lows, the 99th percentile and worst
  frame time (wl-sink times the game's new buffers), pictures/s, wl-sink's
  time, FSR's GPU time and skips, the GPU's awake share and clock from
  i915's sysfs, the CPU (the unit's, and the game's in % of a core) and
  memory (the game's cgroup against its cap, the unit's available memory,
  swap). **What names the limit (0.2.4):** "GPU awake" (to 0.2.3 "GPU
  busy") is time out of RC6, which the GPU enters only after tens of ms
  idle: any game reads 100 %, so it says nothing of how full the GPU is;
  its clock does (the mean, lowest and highest of the window, the clock
  asked for, the limit: a GPU with work waiting is clocked up). With them
  the game's busiest thread by name (one at 100 % is a limit no total
  shows), wineserver's part, the thread count, the three busiest processes
  that aren't the game's, the CPU's share waiting for the disk, what moved
  in and out of swap and the major faults; and in the summary the spread
  of frame times (bunched at two or three frames' time: pacing; spread
  wide: load). Switch modes mid-game, read them after:
  `journalctl -u vizualyse-steam | grep perf:`. With FSR on but not drawing,
  the line says why (`FSR not used: ...`, wl-sink's `fsrWhy`; 0.1.12), and
  wl-sink's `ready` line says whether FSR is ready. Kept beside the journal
  (which holds only the last 10-15 minutes of the tool's lines) in
  `state/perf.log`, each line dated, rotated at 1 MB with one old file kept
  (0.2.0).
- **Performance graphs on the phone page (0.2.0):** each 10 s window also as
  numbers (`perf.point`), the running (or last) game's last hour kept in
  memory; `GET /api/perf?since=<ms>` hands out the newer ones, and the
  page's "Performance graphs" panel (fetched every 10 s only while open)
  draws frames a second with the 1 % low and the pictures shown, the GPU's
  busy share and clock, the CPU, memory and swap, and FSR's and wl-sink's
  time a picture, as inline SVG; dashed lines where the upscaling changed.
  Nothing on the frame path, nothing fetched from outside the car.
- **A window bigger than the picture (0.2.1)** is fitted into it, aspect
  kept, and touches are scaled back (FTL's fixed 1280x720 window showed only
  its top left at 896x320, and its right and bottom couldn't be touched); a
  2-pixel overhang is still trimmed (Godot). The journal: "the window WxH
  fitted into the picture". A window that needs a bigger screen than Wine
  was given restarts the game once with one (0.2.3: calibrating the
  pointer); not one that is only its frame bigger (up to 32 pixels: a
  maximised window is the screen + 12 each way whatever the screen, and
  0.2.3 restarted Slay the Spire 2 for it without end; 0.2.4). With Vulkan on, wl-sink also offers linux-dmabuf
  (ANV 20+); Wine's EGL (Mesa 19) names its buffers' linear, X- or Y-tiled
  layout there anyway, which is taken (0.2.1: Stardew Valley quit at it).
- **Defaults (0.2.1):** Vulkan for every game, 32-bit too (Terraria at twice
  WineD3D's pictures); with Vulkan off, iris over i965.
- **iris for OpenGL (0.2.0, per game, iris the default from 0.2.1):** Mesa 19.3.5's iris
  (`iris.tgz`, `tools/iris.sh` from `tools/iris-bench`: patched for the
  unit's 4.14, its own EGL / GBM / GLES set) for a game's OpenGL and
  WineD3D with Vulkan off, the phone page's "OpenGL driver" button; wl-sink
  stays on the unit's i965. Its gated try passed on the car (2026-11-09); a
  restart of the unit during such a game turns iris off for it.
- **The other tools step back while a game runs (0.1.10):** Steam asks on the
  tools' bus (`native/vizualyse-bus`, `mqtt_bus.js`) for the cluster's and the
  HUD's video off; Cast pauses a stream or CarPlay's second screen there and
  starts it again after the game. It asks `browser` off too: the Browser
  tool stops Chromium until the game ends. The other way, the Browser's game
  mode asks `steam` off: a running game stops when that ask is made after
  the game started (the status's `busNote` and the phone page say who
  asked); one made before doesn't stop it, the newer start wins.
- **Controllers**: wired XInput (Xbox 360-style) USB pads, up to four, as
  vizualyse-moonlight reads them: the car's kernel has no evdev, HID or
  xpad, so `steam-pads` (`src/pads_main.c`, root, while a game runs) finds
  them under `/sys/bus/usb/devices`, claims them through usbfs, lights each
  one's player LED and maps its reports (the platform modules `native/pads`,
  `native/usb_pads`: Moonlight's code) into `/dev/shm/vizualyse-steam/pads`
  (`src/vzs_pads.h`). Wine's own XInput reads its winebus, which has nothing
  to read here, so the prefix gets ours (`src/xinput.c`, 64- and 32-bit,
  mingw) as `xinput1_1` .. `xinput1_4` and `xinput9_1_0` (`=n` overrides):
  `XInputGetState` and the rest read that file. Rumble is accepted and
  dropped; DualShock / DualSense and Bluetooth pads aren't read (as in
  Moonlight); a game that reads only DirectInput or Windows.Gaming.Input
  doesn't see them.
- **Touch**: `steam-touch` (vizualyse-chromium's helper, `src/touch_main.c`)
  reads a passive copy of the display's touch PDUs on vlan73 while the game
  is shown (the HMI still gets every one; nothing is claimed: a claim
  restarted the unit). `server.js` maps a touch on the picture into the
  game's pixels (aspect-kept fit, bars ignored) and hands it to wl-sink
  (`--input`, stdin `d|m|u X Y`), which makes it Wine's pointer on the shown
  window: a tap is a left click, a drag moves with the button held; the
  window gets the keyboard focus too (Wine's foreground window). A tap's
  wobble isn't a drag: moves count from 32 screen pixels away from where
  the finger went down, 64 in the first 250 ms (0.1.12; 14 px still
  scrolled Slay the Spire 2's map on a tap). A tap's button is timed for
  games that read the mouse once a frame (`src/tap.js`, 0.2.0): the pointer
  moves first, the button goes down a frame later, and it is held at least
  150 ms or three of the game's frames (at most 600 ms); Don't Starve took
  quick taps as moves only.
- **A swap file for games (0.1.12):** 4 GB on the hard disk
  (`/var/opt/hdshare/vizualyse-steam/swapfile`, `src/swap.js`), made once in
  the background two minutes after the tool starts (a game sooner than that
  still gets one made earlier, 0.1.13; the journal says when a game gets
  none), on while a game runs
  behind the unit's own compressed swap (zram 3 GB, priority 75; the file
  10), off after it. A game near its cap pushed the HMI's memory into zram
  until it was full and the game stalled for seconds. The deactivate turns
  it off and deletes it; not made with less than 6 GB free on the disk.
- **Run without Steam** (per game, off by default): a game that quits
  without the Steam client ("run the game from Steam") gets gbe_fork's
  `steam_api64.dll` / `steam_api.dll` (Goldberg's emulator, LGPL-3.0, in the
  runtime's `goldberg/`) in place of Steam's, each original kept as
  `<name>.vzs-orig`, with a `steam_settings` folder beside it (the app id,
  the account's name, no networking). Off puts Steam's back; an update or a
  check of the files puts Steam's back and the tool swaps again.
  Achievements and cloud saves stay on the car. An older game's interface
  versions, read from Steam's own DLL, go into `steam_settings/
  steam_interfaces.txt` (0.2.0: Teslagrad's 2013 SDK otherwise reached
  gbe's newest ISteamClient through its older slots). A game wrapped in
  Steam's DRM also needs Remove Steam DRM (next).
- **Remove Steam DRM** (per game, off by default; shown on a game whose
  program has Steam's DRM wrapper, SteamStub: a `.bind` section, spotted at
  install): `steamstub.js`, our own unwrapper (written from the format's
  description, not from another unpacker's source). In every case the
  original entry point is restored, `.bind` dropped when it is last and
  nothing points into it, and the file offsets, sizes and checksum fixed;
  each layout is checked against the program before anything is written.
  Variant 3: the header before the stub's entry point (dwords XOR-chained,
  signature `0xC0DEC0DF`), the code section decrypted (AES-256-CBC, its IV
  ECB-decrypted, the 16 bytes moved into the header put back); 3.1 x86 / x64
  and 3.0 x86 by their known layouts, 3.0 x64 with 3.1's fields (guessed).
  Variant 2.1: the entry point gives the header address and key, the header
  an XOR'd payload, the payload an XTEA-encrypted SteamDRMP.dll whose code
  gives the offsets of the AES-256 parameters (the code section decrypted as
  in variant 3). Variant 2.0: a rolling-XOR header, the code section
  rolling-XOR decoded when the flags say so. Variant 1: no code encryption,
  the original entry point taken from the stub's exit jump. (Variant 2.1 is
  confirmed on the bench against Call of Duty: World at War's CoDWaW.exe and
  CoDWaWmp.exe: both detect and unwrap to a clean PE, and the unwrapped
  CoDWaW.exe then launches under Wine with Run without Steam — window "Call of
  Duty®", its Treyarch intro drawing — where the wrapped one exited at once.
  Variants 1 and 2.0 are so far only round-trip-tested.) Steam's wrapped
  program is kept as `<exe>.vzs-orig`; off puts it
  back; an update that brings it back is unwrapped again. Most such games
  also need Run without Steam: the
  phone page suggests it, nothing forces it. **Off the car only so far:**
  `test/steamstub_test.js` wraps programs of its own and unwraps them byte
  for byte; no real wrapped game yet (Castle Crashers is the first to try).
- **Steam client** (Settings, off by default; `client.js`): off is the light
  mode above. On, every game starts in Valve's own Windows client in the
  prefix (`C:\SteamClient`), signed in with the owner's account: the other way
  to a game with Steam's DRM (Remove Steam DRM takes it off instead; CoD:
  World at War either way), and to games that want Steam itself. Turning it on downloads SteamSetup.exe from Valve through the
  phone, writes the runtime's root certificates into the prefix's registry
  (Wine takes its roots from the unit's `/etc/ssl/certs`, which has only
  BMW's: every HTTPS through Windows' TLS failed, "http error 0"; kept off
  Wine's HostImportedCertificates lists, or Wine deletes them for not being
  on the unit), installs the client, then starts it on the screen to sign
  in (its QR code, scanned with the Steam app, parked); its first start
  updates it (~250 MB) and it restarts itself (the session goes on while a
  Steam.exe does). Play then runs `steam.exe -silent -applaunch <id>`
  straight (no Proton shim, no `steam.exe=b`, `PROTON_DISABLE_LSTEAMCLIENT=1`:
  Proton's loader swaps steamclient.dll for its Linux bridge otherwise), the
  game linked into the client's library (`steamapps/common/vzs-<id>`) with an
  appmanifest whose depots are DepotDownloader's manifests, so the client
  takes it as installed and up to date (without them it downloaded all of
  CoD's 7 GB again). A game's first start may show its extras (DirectX,
  PunkBuster's licence) and the client's notices on the screen, answered
  there. 20 s after the game's process appears the client's web UI
  (steamwebhelper, ~1.9 GB of its ~2.2 GB) is frozen and its memory goes to
  swap under the cap; when the game's process ends, or on Stop, the client
  is asked to shut down (15 s, then killed). The remembered sign-in is
  checked before each start (AutoLoginUser put back if an installer run took
  it). **Off the car only so far** (the play bench, 2026-11-16): a fresh
  prefix to the sign-in's QR code on the screen; with a signed-in client,
  CoD: World at War and Castle Crashers start in it with nothing
  downloaded, the UI frozen, the game's end and Stop end the session.
  `test/client_test.js` checks the library, the certificates, the account.
- **Wine Mono (0.2.0):** GE-Proton's Wine Mono 11.3.0 (with FNA for XNA
  games) stays in `proton/share/wine/mono`, less its debug files: .NET
  Framework games (Terraria) run on it; the prefix is unchanged.
- **Older engines' screens (0.2.0):** Unity 4 takes only display modes of
  640x480 or more, and Wine offers only modes inside its screen, so such a
  game gets the chosen picture's shape at a size that holds 640x480
  (896x320 -> 1344x480); the journal's `screen:` line says so.
- **Godot on OpenGL (0.2.0):** `force_glsl_extensions_warn=true`: its
  GLSL 330 shaders call `packHalf2x16` without enabling the packing
  extension, which Mesa 19 refused (its menu never drew).
- **Its own userland** (`runtime.tgz`): glibc 2.41 and its loader (the unit
  has 2.27, its loader in /lib, no /lib64), Wayland 1.23 (Wine needs >= 1.20;
  the unit has 1.15), xkbcommon, FreeType, GnuTLS, ALSA, OpenSSL. Every ELF
  program of Proton and .NET is pointed at that loader (`patchelf`);
  `LD_LIBRARY_PATH` is set only on their exec. The unit's Mesa 19 is linked
  in ahead (`gpu-libs/`: libEGL, libgbm, libglapi, libGLESv2).
- **32-bit programs**: the unit's 4.14 kernel has no IA32 emulation, so the
  i386 system-call gate (`int $0x80`) faults. Wine's new WoW64 used it
  twice, to give each 32-bit thread its `%fs` (set_thread_area,
  modify_ldt), and every 32-bit program died at start (`Failed to create
  process ...: 731`). `patches/wine-no-ia32.patch` changes Wine's
  `signal_x86_64.c`: the 64-bit `modify_ldt`, and an LDT selector per
  32-bit thread (Wine's own fallback, now wired up for Linux).
  `tools/build_ntdll.sh` rebuilds `ntdll.so` from GE-Proton11-11's own Wine
  tree (Valve's Wine at its pinned commit, Wine Staging, GE's patch script)
  with Proton's compiler flags; built without the patch it matches the
  shipped file (same exports and section sizes). `bundle.sh` swaps it in
  only over that Proton's `ntdll.so` (by its sha256). 32-bit code itself and
  the 64-bit `modify_ldt` work on the unit (tested there).
- **No Python on the car**: Proton's launcher runs once, at build time, to
  make the **Windows prefix** (`prefix.tgz`: a minute on a PC, many on the
  Atom) and to record how it starts a game (`launch.json`: its environment
  and `wine-preloader`, `wine`, `steam.exe`, the game). `server.js` starts
  Wine the same way. The prefix is unpacked once and kept over updates (the
  games' saves live in it).
- **DepotDownloader** (SteamRE, on .NET 10) downloads the Windows depots of
  a game the account owns (`-os windows -osarch 64`). The password goes only
  to its stdin when it asks, Steam Guard codes too; `-remember-password`
  keeps its token in `home/`.
- **The internet**: downloads (and games) run as the tool's **uid 12996**,
  which mgu-uplink routes; names resolve through the phone's DNS, written to
  `/dev/shm/vzs.dns`, which the runtime's `libc.so.6` reads instead of
  `/etc/resolv.conf` (the unit's resolver doesn't resolve internet names).
- **Sound**: Wine's ALSA plays into a FIFO (the runtime's own `asound.conf`,
  never the unit's) that the tool holds open and hands to `pcm_play.py`
  (mgu-python), into SmartXbar's CarPlay input as Moonlight does; the phone
  page's Volume scales it. The FIFO has no clock behind it (a file plugin
  over "null"), so Wine wrote as fast as it could (~3.6x real time on the
  car, nearly all dropped): the tool reads it at the sound's own rate
  (48 kHz stereo), the FIFO small (8 KB), so Wine waits as on a sound card.
- **Games**: in `/var/opt/vizualyse-steam/games/<app id>`, on the unit's
  hard disk (`/var/opt/hdshare/vizualyse-steam/games`, 85 GB on ours) or on
  a **USB stick** (`<stick>/vizualyse-steam/games`), by the phone page's
  setting. The HMI (udisks2) mounts a stick at `/media/<label>` read-only and
  noexec; for games `src/usb.js` makes it read-write in place (the HMI's
  nosuid / nodev / noexec kept: it stays in the media player) and binds it at
  `/var/opt/vizualyse-steam/usb/<label>` with exec. A pulled stick: our
  mount goes (lazily), a game or download on it ends, its games show "plug it
  in". FAT32 works (no file over 4 GB: the phone page says so); exFAT / NTFS
  (the unit's Tuxera drivers) and ext4 too. A game already installed is
  updated where it is. The program to start is guessed (installers,
  redistributables, crash reporters left out; the phone page lists the
  others); **Godot 4** games get `--rendering-driver opengl3` (they default to
  Vulkan / D3D12). Launch options are editable per game.
- **Safety**: games only start when asked, never at boot; **only while
  parked** (the app sends the speed; above 3 km/h the game is hidden and
  won't show); Wine and its processes in a **memory cgroup** (2.5 GB by
  default, the phone page's setting), so only the game can run out;
  `LimitCORE=1` (a game's process is named after its .exe, on no crash list:
  a core dump of an unlisted program can restart the unit); the service on
  recmgr's whitelist. While a game runs, `state/game-running` names it: found
  at start, the unit restarted during it, and the app and phone page say so.

## How it works

| Part | Runs as | Does |
|---|---|---|
| `server.js` | root | unpacks the bundles; the phone page on port 8494 (token in the QR link); the iDrive app's socket; downloads, the library, games; show / hide; only while parked; the cgroup; the phone's DNS |
| `usb.js` | root | USB sticks as an install location: the HMI's mount read-write, our exec view, a pulled stick's mount gone |
| `unpack.js` | root | each `.tgz` into its folder once (sha256 stamp), streamed, links made last, swapped in by rename |
| `steam.js` | - | DepotDownloader and its questions; finding a game's program; the store's name for an app id |
| `steamstub.js` | root | Steam's DRM wrapper (SteamStub 1, 2 and 3) found on a game's program and taken off in place (Remove Steam DRM) |
| `client.js` | root (the client: uid 12996) | the Steam client setting: Valve's client in the prefix, its installer, the root certificates, the library, the sign-in; Steam.exe in a game's session |
| `game.js` | root | one game: the frame file, wl-sink, Wine (`launch.json`), the sound FIFO and player; Stop: `wineserver -k`, then whatever is left in the cgroup |
| `wl-sink` | root, then uid 12996, group video | C (`src/wl_sink.c`): maps the frame file, drops to the uid, then the Wayland compositor Wine draws into; touches on its stdin become Wine's pointer |
| `steam-touch` | root, then nobody | C (`src/touch_main.c`): the display's touches while the game is shown, read passively |
| `steam-pads` | root | C (`src/pads_main.c`): XInput USB pads through usbfs while a game runs, their state into the pads file |
| `xinput1_4.dll` | in Wine (the game) | Windows DLL (`src/xinput.c`): XInput from the pads file |
| Wine, the game | uid 12996, group video (44) | Proton's Wine in the prefix, on the unit's Mesa 19, in the memory cgroup |
| DepotDownloader | uid 12996 | `dotnet DepotDownloader.dll`, HOME `/var/opt/vizualyse-steam/home` |
| `screen.js` | root | the mgu-render client in layer mode, in the app area |
| `touch_screen.js`, `touch_view.js` | root | the touch screen (the platform's touch kit: `ui_*.js`, `touch_reader.py`, `ui.*` fonts) and its two tabs; one picture at a time with the game |
| `art.js`, `jpeg.js`, `ico.js` | root (the fetch: uid 12996) | the games' pictures on the cards: Steam's store picture (`capsule_616x353.jpg`, else the store's header), fetched once through the phone into `state/art/<appid>.jpg`, read by our own baseline JPEG reader; else the icon in the game's program; made at the size drawn, in the background |
| `control.js` | root | `/dev/shm/vizualyse-steam/ctl.sock` for the app only: status; enable, disable, play, stop, show, hide, ui, resolution, upscale, speed; the `list` event |
| `firewall.js` | root | the phone page's TCP 8494 on `wlan0`, in memory |
| `swap.js` | root | the games' swap file on the hard disk: made once, on while a game runs |
| `deactivate.js` | root | the deactivate hook: the firewall rule and the swap file removed |

State in `/var/opt/vizualyse-steam/state` (root): the token, the settings,
the library (`library.json`), `game-running` while a game runs, the games'
store pictures (`art/<appid>.jpg`).

## Off the car

- `sh build.sh` builds the bundles in `image/Dockerfile` (Debian trixie
  from snapshot.debian.org at a fixed date): downloads GE-Proton, .NET and
  DepotDownloader into the Docker volume `steam-build-dl` (checked by hash),
  trims Proton, makes the prefix with Proton itself, captures `launch.json`
  (`tools/bundle.sh` has the details). Two builds give the same bytes. Proton
  is never unpacked on the Windows drive (Windows Defender removed one of
  Wine's DLLs there, 2026-11-06).
- `sh test/run_unit_test.sh [stub|swrast]` runs the tool end to end in a
  container made from the **unit's own root filesystem**
  (`../idrive-rootfs`: glibc 2.27, Node 8.16, its Mesa 19), no network, on
  tools/gpu-bench's stand-in GPU (`stub`: the unit's i965 on a fake HD 505,
  no pixels; `swrast`: llvmpipe through the unit's EGL, real pixels)
  (`test/unit_test.js`): the bundles unpack (20 s on a PC); the real
  DepotDownloader starts on our .NET as uid 12996; a download through a
  stand-in with the real one's prompts (`test/fake_dd.js`: password, a wrong
  and a right Steam Guard code, progress); the game in the library with its
  program; playing it (`test/win/t_d3d9.c` as the game): Wine starts, its
  frames reach the frame file (PRIME buffers on the stub, ~29 pictures/s;
  the right picture on swrast), Direct3D reports HD Graphics 510; Stop ends
  every process of the uid. `VERBOSE=1`, `GREP_LOG=regex` show the tool's log.
- `node test/steamstub_test.js` checks Remove Steam DRM: small x86 / x64
  programs made in the test, wrapped by the test's own SteamStub packer
  (3.1, 3.0, 2.1, 2.0 and 1; encrypted or not; the code section's file size
  shrunk; an overlay; a checksum), unwrapped back to the original byte for
  byte; a `.bind` a directory points into kept; a `.bind` of no header we
  know, truncated and garbled files refused cleanly; the in-place switch
  through an update. Node 8 in CI.
- `node test/touch_test.js [out dir]` checks the touch screen: both tabs in
  every state lint clean (targets 64 px or more, none overlapping) and are
  written as PNGs; one picture at a time against a stand-in game and
  mgu-render client; taps. As root on Linux (Node 8 in a container:
  `docker run --rm -v "$PWD:/w" ml-unit:18.04-node8 sh -c 'cp -r /w /x && cd /x && node native/vizualyse-steam/test/touch_test.js'`)
  also `server.js` itself, with no bundles, driven over the control socket
  with touches from a stand-in reader (`test/fake_touch.js`).
- `sh test/run_bench.sh` runs Windows test programs through Proton in a
  Debian container with the unit's Mesa (the first bench, below).
- `sh test/run_play.sh` leaves the tool running in the unit's root
  filesystem for a **real game** (`test/play_main.js`): the internet for
  DepotDownloader, the phone page on `http://localhost:8494` (it prints the
  link), `/var/opt` in the Docker volume `steam-play-varopt` (the sign-in,
  the games and the prefix stay; nothing on the Windows drive), the stub
  GPU. Every CPU-side step is real and the GPU takes no time, so what holds
  a game under its frame rate there is ours: read the tool's `perf:` lines
  (`run_play.sh log`, `perf`) and its `play: cpu:` lines (the busiest
  threads by name, every 10 s). `PLAY_CRUMBS=off` plays a Vulkan game
  without the crumbs log; `PLAY_FAKE=t_d3d964.exe` checks the bench itself
  with the test program as the game, no Steam. Wine's fsync is off there,
  as on the car's kernel (`PLAY_SYNC=fsync` to compare).
  **Seeing and steering a game:** `GPU=lavapipe` draws a Vulkan game on
  Mesa's CPU driver in ANV's place (real pictures, slowly);
  `run_play.sh shot F.png` is its newest picture, `tap X Y` / `drag` a
  touch on it (the tool's own touch path, one tap a call), `pad BUTTONS` /
  `stick LX LY MS` a controller (the pads file our `xinput1_4.dll` reads),
  `cpu [S]` every thread's share as milliseconds a frame
  (`test/play_input.js`, `play_cpu.js`). Find the taps into a scene on
  lavapipe, then replay them on the stub to time it: there are no pictures
  on the stub, so ask the game's own log whether it got there (Vampire
  Survivors: `GameManager:PostStageInit` in its `Player.log`).
- What the bench can't tell: the unit's kernel and GPU (a hang, the real
  frame rate), the Atom's speed.

### The first bench

```sh
sh test/run_bench.sh swrast                # every test program, Mesa 19 llvmpipe: real pixels
sh test/run_bench.sh stub t_d3d964         # the unit's own i965 on a fake HD 505: no pixels
COMPOSITOR=wl-sink sh test/run_bench.sh swrast t_d3d932   # ours instead of weston
```

A trixie container (`image/bench.Dockerfile`) loads the unit's own Mesa 19
(`tools/unit_gl.sh` copies it from `../idrive-rootfs`) with tools/gpu-bench's
stand-in, starts a compositor, and runs each program with Proton from the
Docker volume `steam-bench-proton` (`tools/fetch_proton.sh`)
(`test/in_bench.sh`). Test programs (`test/win/*.c`, 64- and 32-bit, mingw:
`test/build_win.sh`) write their lines to `T_LOG`: `t_gdi`, `t_d3d9`
(adapter, caps, frames, a triangle read back; `T_D3D9_CHECK_PIXELS=1`,
`T_FRAMES`), `t_xinput`, `t_load`. Afterwards `build/out/` holds Proton's
log, the programs' lines, the compositor's events and its last picture.
Settings: `PROTON_VER`, `WOW64=new|classic`, `COMPOSITOR`, `WINEDEBUG`,
`T_TIMEOUT`, `SHOW_LOG=N`, `T_ENV`, `WL_SINK_WRAP` (e.g. strace), `DOCKER_ARGS`.

## On the car

Read-only, from the journal and the state folder (ask before anything else
on the unit):

- `journalctl -u vizualyse-steam | grep -E 'bundle:|game:|wl-sink:|wine:|steam:'`;
- the first game: `wl-sink: ready ... GPU buffers through /dev/dri/renderD128`,
  `game: running`, the pictures per second on the phone page;
- `dmesg | grep -iE 'i915|blocked for more'` afterwards must show no GPU hang.
- The touch screen (0.3.0, not tried on the car yet): `ui: shown`, `ui:
  hidden (the game is shown)` then `ui: shown` again when the game is
  hidden, and the time from a touch to its pixels (`ui: N touches to
  pixels: median ...`).

## Licenses

GPL-3.0-or-later. `src/protocol/wayland-drm.xml` is Mesa's, under its own
permissive notice (in the file). It, `src/frame_out.*`, `src/touch.*` and `src/pcm_play.py` are
copies of the platform's ([platform/](../../platform)). What the bundles carry and where
their sources are: [THIRD-PARTY.md](THIRD-PARTY.md).
