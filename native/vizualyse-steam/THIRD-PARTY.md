# Third-party software in vizualyse-steam

The tool's own code (`src/`, `tools/`, `test/`, `image/`) is GPL-3.0-or-later
(`LICENSE`). `src/protocol/wayland-drm.xml` is Mesa's, under its own
permissive notice (in the file); it, `src/frame_out.*` and `src/pcm_play.py` are
copies of platform modules (native/wayland_drm, native/frame_out,
tool/pcm_play; those two ours, GPL-3.0-or-later).

`src/fsr.c` (in `wl-sink`) ports the shaders of **AMD FidelityFX Super
Resolution 1** (`ffx_fsr1.h`, `ffx_a.h` from
<https://github.com/GPUOpen-Effects/FidelityFX-FSR>: EASU and RCAS, 32-bit)
to GLES 3.0, under AMD's MIT licence:

> Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
> THE SOFTWARE.

The tool ships four archives, built by `tools/bundle.sh` (`vulkan.tgz` by
`tools/vulkan.sh`):

| Archive | What | Licence |
|---|---|---|
| `proton.tgz` | **GE-Proton** 11-11 (Wine with Proton's and GloriousEggroll's patches), trimmed (`tools/bundle.sh` says what is left out); the program interpreter of its ELF programs pointed at the runtime's loader by `patchelf`; **`lib/wine/x86_64-unix/ntdll.so` rebuilt** from GE-Proton's own Wine tree with `patches/wine-no-ia32.patch` (Wine's `dlls/ntdll/unix/signal_x86_64.c`: the 32-bit `%fs` through the 64-bit `modify_ldt`, an LDT selector per thread, for kernels without IA32 emulation; `tools/build_ntdll.sh`), nothing else changed | Wine: LGPL-2.1-or-later; Proton: BSD-3-Clause; the rest each its own (`proton/LICENSE`, `LICENSE.OFL`, `PATENTS.AV1`) |
| `prefix.tgz` | the Windows prefix Proton made at build time from its own files (above) | as above |
| `runtime.tgz` | GNU C library 2.41 and every library Wine, wl-sink and .NET load, from **Debian 13 (trixie)** (`libc.so.6` reads `/dev/shm/vzs.dns` instead of `/etc/resolv.conf`: one string changed); **.NET** 10 runtime; **DepotDownloader** 3.4.0 (SteamRE); **gbe_fork** (Goldberg's Steam emulator) release-2026_09_27: its regular `steam_api64.dll` / `steam_api.dll`, unchanged (`runtime/goldberg/`, for a game's "Run without Steam") | glibc: LGPL-2.1-or-later; each Debian package its own (`runtime/licenses/<package>.txt`); .NET: MIT (`runtime/licenses/dotnet-*.txt`); DepotDownloader: GPL-2.0 (`runtime/licenses/DepotDownloader-LICENSE.txt`); gbe_fork: LGPL-3.0 (`runtime/licenses/gbe_fork-LICENSE.txt`) |
| `vulkan.tgz` | **Mesa** 19.0.6's Intel Vulkan driver (ANV, `libvulkan_intel.so`, unchanged, built for the unit by `tools/vk-trial/image/Dockerfile`); the **Khronos Vulkan loader** 1.1.70 (`libvulkan.so.1`, Ubuntu 18.04's `libvulkan1`); **DXVK** 1.9.4's release DLLs, unchanged (`dxvk/x64`, `dxvk/x32`); `vk_crumbs.so` (ours, `tools/vk-trial/src/vk_crumbs.c`) | Mesa: MIT (`vulkan/licenses/mesa.html`); the loader: Apache-2.0 (`vulkan/licenses/vulkan-loader.txt`); DXVK: zlib (`vulkan/licenses/dxvk.txt`); `vk_crumbs.so`: GPL-3.0-or-later |

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
- Mesa: <https://archive.mesa3d.org/older-versions/19.x/mesa-19.0.6.tar.xz>
  (sha256 in `tools/vk-trial/image/Dockerfile`, built there with
  `-Dvulkan-drivers=intel -Dplatforms=drm,wayland`).
- The Vulkan loader: Ubuntu 18.04's `vulkan` source package (1.1.70), and
  <https://github.com/KhronosGroup/Vulkan-Loader>.
- DXVK: <https://github.com/doitsujin/dxvk>, tag `v1.9.4` (its release
  `dxvk-1.9.4.tar.gz`, sha256 in `tools/vulkan.sh`).
- gbe_fork: <https://github.com/Detanup01/gbe_fork>, tag `release-2026_09_27`
  (the release's `emu-win-release-vs22.7z`, `release/regular/`).
- `src/touch_main.c` (`steam-touch`) and
  `test/fake_render_client.js` are copies of vizualyse-chromium's; `src/touch.*`,
  `src/pads.*`, `src/pad_flags.h`, `src/usb_pads.*`, `test/pads_test.c` and
  `test/usbip_pad.c` are the platform's (modules native/touch, native/pads,
  native/usb_pads, native/usbip_pad; vizualyse-moonlight's gamepad code);
  `src/xinput.c` builds the Windows `xinput1_4.dll` the prefix gets (all ours,
  GPL-3.0-or-later). `pad_flags.h`'s button values are moonlight-common-c's
  (XInput's bits).

On request we provide the same sources.
