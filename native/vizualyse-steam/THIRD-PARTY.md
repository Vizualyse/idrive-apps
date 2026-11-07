# Third-party software in vizualyse-steam

The tool's own code (`src/`, `tools/`, `test/`, `image/`) is GPL-3.0-or-later
(`LICENSE`). `src/protocol/wayland-drm.xml` is Mesa's, under its own
permissive notice (in the file); it, `src/frame_out.*` and `src/pcm_play.py` are
copies of platform/<version>/ (those two ours, GPL-3.0-or-later).

The tool ships three archives, built by `tools/bundle.sh`:

| Archive | What | Licence |
|---|---|---|
| `proton.tgz` | **GE-Proton** 11-11 (Wine with Proton's and GloriousEggroll's patches), trimmed (`tools/bundle.sh` says what is left out); the program interpreter of its ELF programs pointed at the runtime's loader by `patchelf`; **`lib/wine/x86_64-unix/ntdll.so` rebuilt** from GE-Proton's own Wine tree with `patches/wine-no-ia32.patch` (Wine's `dlls/ntdll/unix/signal_x86_64.c`: the 32-bit `%fs` through the 64-bit `modify_ldt`, an LDT selector per thread, for kernels without IA32 emulation; `tools/build_ntdll.sh`), nothing else changed | Wine: LGPL-2.1-or-later; Proton: BSD-3-Clause; the rest each its own (`proton/LICENSE`, `LICENSE.OFL`, `PATENTS.AV1`) |
| `prefix.tgz` | the Windows prefix Proton made at build time from its own files (above) | as above |
| `runtime.tgz` | GNU C library 2.41 and every library Wine, wl-sink and .NET load, from **Debian 13 (trixie)** (`libc.so.6` reads `/dev/shm/vzs.dns` instead of `/etc/resolv.conf`: one string changed); **.NET** 10 runtime; **DepotDownloader** 3.4.0 (SteamRE); **gbe_fork** (Goldberg's Steam emulator) release-2026_09_27: its regular `steam_api64.dll` / `steam_api.dll`, unchanged (`runtime/goldberg/`, for a game's "Run without Steam") | glibc: LGPL-2.1-or-later; each Debian package its own (`runtime/licenses/<package>.txt`); .NET: MIT (`runtime/licenses/dotnet-*.txt`); DepotDownloader: GPL-2.0 (`runtime/licenses/DepotDownloader-LICENSE.txt`); gbe_fork: LGPL-3.0 (`runtime/licenses/gbe_fork-LICENSE.txt`) |

`bundle-VERSION.txt` lists the exact versions and Debian packages.

**Source code:**

- GE-Proton: <https://github.com/GloriousEggroll/proton-ge-custom>, tag
  `GE-Proton11-11` (its release carries the sources it was built from); Wine
  and Proton upstream at <https://gitlab.winehq.org/wine/wine> and
  <https://github.com/ValveSoftware/Proton>.
- The rebuilt `ntdll.so`: Valve's Wine (<https://github.com/ValveSoftware/wine>)
  at the commit GE-Proton11-11 pins (`c53678ab22a85f0fad3588dd34f0452a463bd015`),
  Wine Staging at `6cc805ea57132eeaf44764e9213823c9b8d0d300`, GE's patches
  (its `patches/protonprep-valve-staging.sh`, Wine section), then our
  `patches/wine-no-ia32.patch` (in this repository, LGPL-2.1-or-later as Wine);
  `tools/build_ntdll.sh` does exactly that.
- Debian packages: installed from [snapshot.debian.org](https://snapshot.debian.org/)
  at the date in `image/Dockerfile` (`SNAPSHOT`); the source packages are
  there at the same versions.
- .NET: <https://github.com/dotnet/runtime>, release 10.0.14.
- DepotDownloader: <https://github.com/SteamRE/DepotDownloader>, tag
  `DepotDownloader_3.4.0`.
- gbe_fork: <https://github.com/Detanup01/gbe_fork>, tag `release-2026_09_27`
  (the release's `emu-win-release-vs22.7z`, `release/regular/`).
- `src/touch_main.c`, `src/touch.c`, `src/touch.h` (`steam-touch`) and
  `test/fake_render_client.js` are copies of vizualyse-chromium's (ours,
  GPL-3.0-or-later).

On request we provide the same sources.
