# vizualyse-steam

**Steam** for the iDrive 7 head unit: Windows games from your Steam library
running on the unit itself through **Proton** (GE-Proton 11, Wine), drawn
on the unit's own GPU driver and shown on the central screen while parked,
with sound. Sign in and install games on a phone page; play them from the
iDrive or the phone. Experimental: built and tested off the car on the
unit's own root filesystem (below); **nothing has run on the car yet.**
Background: [knowledge/games.md](../../knowledge/games.md).

**Not in this version:** any input to the game (no touch, keyboard or game
controllers yet), .NET Framework games (no Wine Mono), games that need the
Steam client running (it doesn't run here). 64-bit games start on the car
(Slay the Spire 2 drew there). **32-bit games** need our rebuilt `ntdll.so`
(below, "32-bit programs"): tested off the car, not yet on it.

1. Install **Steam** (this tool) and the **Steam** iDrive app
   ([apps/vizualyse_steam](../../apps/vizualyse_steam)) from the Store. The
   first start unpacks Proton, its runtime and a Windows prefix (about
   1.3 GB in `/var/opt`, a few minutes; the app says so).
2. Open **Steam** on the iDrive, scan the QR code with the phone whose
   hotspot the car is on. On the phone page: your Steam **account name**,
   then **Install** with the game's app id (the number in its store
   address; **Slay the Spire 2** has a button: 2868840). Steam asks for the
   password and a Steam Guard code (or approval in the Steam app) right on
   the page, once: the car keeps only Steam's sign-in token.
3. When it is installed, **Play: <game>** on the iDrive page (or Play on
   the phone). Starting takes a while (Wine, then the game); the game shows
   by itself once it draws. The back arrow on the left (or HOME, a pop-up,
   a call) hides it; it keeps running until **Stop the game**.

## Why it is built this way

- **Proton with WineD3D on OpenGL** (`PROTON_USE_WINED3D=1`): the unit's
  4.14 kernel has no Vulkan, so no DXVK / VKD3D; Direct3D 9 to 11 become
  OpenGL on the unit's own **Mesa 19 i965** (desktop GL 4.5 core), the
  driver the HMI uses. No GPU driver of ours (the browser's 0.1.1 hung the
  kernel with one: knowledge/browser.md); `tools/bundle.sh` refuses one.
- **Wine's Wayland driver into wl-sink**: the unit's EGL has no X11, and the
  screen belongs to Winston and the HMI. `wl-sink` (`src/wl_sink.c`) is the
  smallest compositor Wine takes; Mesa's Wayland EGL hands it each frame as a
  **PRIME buffer** (`wl_drm`), which it imports on the GPU and writes into
  mgu-render's frame file (I420), shown in the app area (1790x638 at
  +108+82), aspect kept. The game draws at the **Picture** size (1280x720 by
  default; 1344x480 is the screen's shape).
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
  page's Volume scales it.
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
| `game.js` | root | one game: the frame file, wl-sink, Wine (`launch.json`), the sound FIFO and player; Stop: `wineserver -k`, then whatever is left in the cgroup |
| `wl-sink` | root, then uid 12996, group video | C (`src/wl_sink.c`): maps the frame file, drops to the uid, then the Wayland compositor Wine draws into |
| Wine, the game | uid 12996, group video (44) | Proton's Wine in the prefix, on the unit's Mesa 19, in the memory cgroup |
| DepotDownloader | uid 12996 | `dotnet DepotDownloader.dll`, HOME `/var/opt/vizualyse-steam/home` |
| `screen.js` | root | the mgu-render client in layer mode, in the app area |
| `control.js` | root | `/dev/shm/vizualyse-steam/ctl.sock` for the app only: status; enable, disable, play, stop, show, hide, resolution, speed |
| `firewall.js` | root | the phone page's TCP 8494 on `wlan0`, in memory |

State in `/var/opt/vizualyse-steam/state` (root): the token, the settings,
the library (`library.json`), `game-running` while a game runs.

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
- `sh test/run_bench.sh` runs Windows test programs through Proton in a
  Debian container with the unit's Mesa (the first bench, below).
- What the bench can't tell: the unit's kernel and GPU (a hang, the real
  frame rate), the Atom's speed, real games, Steam's servers.

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

## Licenses

GPL-3.0-or-later. `src/protocol/wayland-drm.xml` is Mesa's, under its own
permissive notice (in the file). `src/frame_out.*` is vizualyse-chromium's,
`src/pcm_play.py` vizualyse-moonlight's. What the bundles carry and where
their sources are: [THIRD-PARTY.md](THIRD-PARTY.md).
