# Third-party software in Cast to cluster

## ffmpeg (GPL-3.0)

The tool kit ships `ffmpeg`, the unmodified static x86-64 Linux build by
John Van Sickle (https://johnvansickle.com/ffmpeg/). `tools/fetch_ffmpeg.js`
downloads it at build time and checks it against a pinned hash.

| | |
|---|---|
| Archive | `ffmpeg-7.0.2-amd64-static.tar.xz` |
| SHA-256 | `abda8d77ce8309141f83ab8edf0596834087c52467f6badf376a6a2a4c87cf67` |
| MD5 | `7fa72b652e19bf84c9461e332ea1cdf3` |
| ffmpeg | 7.0.2 |
| License | GNU GPL version 3 (`ffmpeg-GPLv3.txt`, shipped next to the binary) |

The build statically links these libraries (from the archive's `readme.txt`):

| Library | Version | | Library | Version |
|---|---|---|---|---|
| libaom | 3.2.0-393-g402e264b94 | | libgnutls | 3.7.2 |
| libass | 0.17.3 | | libtheora | 1.2.0alpha1+git |
| libgme | 0.6.3 | | libfrei0r | 1.6.1-2 |
| libsrt | 1.4.4 | | libvidstab | 1.20 |
| libvpx | 1.11.0-30-g888bafc78 | | libfreetype | 2.9.1-3+deb10u1 |
| libvmaf | 2.3.0 | | libharfbuzz | 3.1.1 |
| libx264 | 0.164.3191 | | libopenjpeg | 2.4.0 |
| libx265 | 3.5+1-f0c1022b6 | | libalsa | 1.2.4 |
| libxvid | 1.3.7 | | libsoxr | 0.1.3 |
| libwebp | 0.6.1 | | libopus | 1.3.1 |
| libzimg | 3.0.3 | | libspeex | 1.2 |
| libzvbi | 0.2.36 | | libvorbis | 1.3.7 |
| libdav1d | 1.4.2 | | libmp3lame | 3.100 |
| librubberband | 1.8.2 | | libvo-amrwbenc | 0.1.3-1+b1 |
| libopencore-amrnb | 0.1.3-2.1+b2 | | libopencore-amrwb | 0.1.3-2.1+b2 |

Built with gcc 8.3.0, yasm 1.3.0.36.ge2569 and nasm 2.15.05.

### Source code

- ffmpeg 7.0.2: https://ffmpeg.org/releases/ffmpeg-7.0.2.tar.xz
  (git tag `n7.0.2` at https://git.ffmpeg.org/ffmpeg.git)
- The libraries above: each project's upstream source at the version listed.
- The build itself: https://johnvansickle.com/ffmpeg/

**Written offer.** For at least three years after the last release that
includes this binary, the complete corresponding source for it is available
on request, at no charge beyond the cost of providing it, from the
maintainer of this repository (https://github.com/Vizualyse).

## Other components

- `cluster_render_client.js`: MPL-2.0 (`LICENSES/MPL-2.0.txt`), by Robert
  Nisipeanu, from
  [cluster-render](https://github.com/robertnisipeanu/idrive-apps/tree/main/native/cluster-render).
- `qrcode.js`: Kazuhiko Arase's QR Code Generator, MIT.

Everything else in this tool is GPL-3.0-or-later (`LICENSE`).
