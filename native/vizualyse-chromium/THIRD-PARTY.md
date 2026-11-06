# Third-party software in vizualyse-chromium

The tool's own code (`src/`, `sink/`, `tools/`, `test/`) is GPL-3.0-or-later
(`LICENSE`). `chromium.tgz` holds binaries from **Debian 13 (trixie)** (and the Vulkan driver from Debian 12),
unchanged except for the program interpreter that `patchelf` points at the
bundle's own loader in `chromium` and `chrome_crashpad_handler`:

| What | Debian package (version) | Licence |
|---|---|---|
| Chromium | `chromium` 156.0.8078.79-1~deb13u1 | BSD-3-Clause and others (`licenses/chromium.txt`) |
| Mesa ANV (the Vulkan driver) | `mesa-vulkan-drivers` 22.3.6-1+deb12u2 (Debian 12 bookworm: only `libvulkan_intel.so`) | MIT and others (`licenses/mesa-vulkan-drivers-bookworm.txt`) |
| GNU C library | `libc6` 2.41 | LGPL-2.1-or-later |
| libjpeg-turbo (chromium-sink) | `libturbojpeg0` | IJG, BSD-3-Clause, Zlib |
| DejaVu and Liberation fonts | `fonts-dejavu-core`, `fonts-liberation` | Bitstream Vera licence; SIL OFL 1.1 |
| every other library they load | listed in the bundle's `VERSION` | each package's own |

The copyright file of every package a bundled file comes from is in the
bundle at `/var/opt/vizualyse-chromium/chromium/licenses/<package>.txt`, and
the exact package list and versions in `VERSION` (also shipped as
`bundle-VERSION.txt`).

**Source code:** every package was installed from
[snapshot.debian.org](https://snapshot.debian.org/) at the date in
`image/Dockerfile` (`SNAPSHOT`); the corresponding source packages are
there at the same versions (`apt-get source <package>=<version>` against
that snapshot, or the package's page on snapshot.debian.org). On request we
provide the same sources.
