# Third-party software in Moonlight (vizualyse-moonlight)

## moonlight-core: moonlight-common-c (GPL-3.0), ENet (MIT), nanors (MIT), Opus (BSD-3-Clause)

`moonlight-core` is built from `core/` (this tool's own code, GPL-3.0-or-later)
and the vendored sources in `third_party/moonlight-common-c`, unmodified
(`third_party/VERSIONS` names the commits):

| Component | Version | License | Source |
|---|---|---|---|
| moonlight-common-c | commit `e80a786afedeaccff63e839e68c8f3d8a057c13d` (2026-11-02) | GNU GPL version 3 | https://github.com/moonlight-stream/moonlight-common-c |
| ENet (moonlight's fork, a submodule of the above) | commit `aca87840b57f045a1f7f9299e4b1b9b8e2a5e2f1` | MIT | https://github.com/cgutman/enet |
| nanors (a submodule of the above) | commit `a9b1636f9c98dbfdd0daeaf6982ccd24d1c30f29` | MIT | https://github.com/sleepybishop/nanors |
| libopus, linked in statically | 1.1.2 (Ubuntu 18.04's `libopus-dev 1.1.2-1ubuntu1`) | BSD-3-Clause | https://opus-codec.org/, http://archive.ubuntu.com/ubuntu/pool/main/o/opus/ |

It links dynamically against the head unit's own glibc 2.27 and OpenSSL 1.1
(`libcrypto.so.1.1`); neither is shipped. Built with gcc 8.4.0
(`gcc-8 8.4.0-1ubuntu1~18.04`) in `image/Dockerfile`.

The ENet, nanors and Opus license texts:

### ENet

```
Copyright (c) 2002-2020 Lee Salzman

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### nanors

```
MIT License

Copyright (c) 2021 Joseph Calderon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Opus

```
Copyright 2001-2011 Xiph.Org, Skype Limited, Octasic,
        Jean-Marc Valin, Timothy B. Terriberry,
        CSIRO, Gregory Maxwell, Mark Borgerding,
        Erik de Castro Lopo

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:

- Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.

- Redistributions in binary form must reproduce the above copyright
notice, this list of conditions and the following disclaimer in the
documentation and/or other materials provided with the distribution.

- Neither the name of Internet Society, IETF or IETF Trust, nor the
names of specific contributors, may be used to endorse or promote
products derived from this software without specific prior written
permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
``AS IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER
OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
```

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

## The protocol

`gamestream.js` (pairing, the app list, launch) is this tool's own code; it
follows moonlight-embedded's `libgamestream/client.c` (GPL-3.0-or-later,
https://github.com/moonlight-stream/moonlight-embedded) and moonlight-qt's
pairing checks.

Everything else in this tool is GPL-3.0-or-later (`LICENSE`).
