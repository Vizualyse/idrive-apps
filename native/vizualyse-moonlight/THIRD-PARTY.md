# Third-party software in Moonlight (vizualyse-moonlight)

## moonlight-core: moonlight-common-c (GPL-3.0), ENet (MIT), nanors (MIT), Opus (BSD-3-Clause), FFmpeg (LGPL-2.1+), Intel Media SDK headers (MIT)

`moonlight-core` is built from `core/` (this tool's own code, GPL-3.0-or-later)
and the vendored sources in `third_party/moonlight-common-c`, unmodified
(`third_party/VERSIONS` names the commits):

| Component | Version | License | Source |
|---|---|---|---|
| moonlight-common-c | commit `e80a786afedeaccff63e839e68c8f3d8a057c13d` (2026-11-02) | GNU GPL version 3 | https://github.com/moonlight-stream/moonlight-common-c |
| ENet (moonlight's fork, a submodule of the above) | commit `aca87840b57f045a1f7f9299e4b1b9b8e2a5e2f1` | MIT | https://github.com/cgutman/enet |
| nanors (a submodule of the above) | commit `a9b1636f9c98dbfdd0daeaf6982ccd24d1c30f29` | MIT | https://github.com/sleepybishop/nanors |
| libopus, linked in statically | 1.1.2 (Ubuntu 18.04's `libopus-dev 1.1.2-1ubuntu1`) | BSD-3-Clause | https://opus-codec.org/, http://archive.ubuntu.com/ubuntu/pool/main/o/opus/ |
| FFmpeg's libavcodec and libavutil, linked in statically: the H.264 decoder alone (`configure --disable-everything --enable-decoder=h264`, `image/Dockerfile`), unmodified | 6.1.2 (GitHub's archive of tag `n6.1.2`, SHA-256 `9cbefd67b7e4fffde3846699ec03324b7ef789a81c2e9b1059e93719b5b8d189`) | GNU LGPL version 2.1 or later (`ffmpeg-LGPL-2.1.txt`, shipped next to the binary) | https://ffmpeg.org/releases/ffmpeg-6.1.2.tar.xz, https://github.com/FFmpeg/FFmpeg/tree/n6.1.2 |
| Intel Media SDK API headers, a subset (`core/mfx/`, as upstream's `native/waze-on-cluster/abi/include/mfx`) | API 1.24 | MIT (`core/mfx/LICENSE`) | https://github.com/Intel-Media-SDK/MediaSDK |

It links dynamically against the head unit's own glibc 2.27 and OpenSSL 1.1
(`libcrypto.so.1.1`), and loads the unit's own Intel Media SDK
(`libmfxhw64.so`) and libva (`libva.so.1`, `libva-drm.so.1`) at run time
for decoding on the GPU; none of them is shipped. `core/decode_msdk.c` is
ported from Robert Nisipeanu's `native/waze-on-cluster/src/decoder_msdk.cpp`
(GPL-3.0-or-later, https://github.com/robertnisipeanu/idrive-apps, commit
`daaa3f7`).

Relinking: moonlight-core is built from source by `build.sh`; replacing
FFmpeg's libraries means building them (as `image/Dockerfile` does) and
running `build.sh`, which links them in. Built with gcc 8.4.0
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

## The stop hint

`hint.rgba` is a picture drawn at build time (`tools/make_hint.py`) with
DejaVu Sans Bold (Bitstream Vera license; DejaVu's changes public domain,
https://dejavu-fonts.github.io/); the font itself is not shipped.

## cluster_render_client.js (MPL-2.0)

Robert Nisipeanu's client for
[cluster-render](https://github.com/robertnisipeanu/idrive-apps/tree/main/native/cluster-render),
as in Cast (`LICENSES/MPL-2.0.txt` at the repository's root).

## The protocol

`gamestream.js` (pairing, the app list, launch) is this tool's own code; it
follows moonlight-embedded's `libgamestream/client.c` (GPL-3.0-or-later,
https://github.com/moonlight-stream/moonlight-embedded) and moonlight-qt's
pairing checks.

Everything else in this tool is GPL-3.0-or-later (`LICENSE`).
