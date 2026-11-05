# Third-party software in vizualyse-chromium

The tool's own code (`src/`, `sink/`, `tools/`, `test/`) is GPL-3.0-or-later
(`LICENSE`). `chromium.tgz` holds binaries from **Debian 13 (trixie)**,
unchanged except for the program interpreter that `patchelf` points at the
bundle's own loader in `chromium` and `chrome_crashpad_handler`:

| What | Debian package (version) | Licence |
|---|---|---|
| Chromium | `chromium` 156.0.8078.79-1~deb13u1 | BSD-3-Clause and others (`licenses/chromium.txt`) |
| Mesa (ANV Vulkan, iris, EGL, GBM) | `mesa-vulkan-drivers`, `libgl1-mesa-dri`, `libegl-mesa0`, `libgbm1`, `mesa-libgallium` 25.0.7-2+deb13u1 | MIT and others |
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
