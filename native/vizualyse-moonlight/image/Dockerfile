# Builds moonlight-core against the unit's own libraries: Ubuntu 18.04 has
# glibc 2.27 and OpenSSL 1.1 (libcrypto.so.1.1), as the unit (MGU I_21w12).
# libopus is linked in statically: the unit has none. gcc 8: nanors (the
# video FEC) needs its GFNI intrinsics, which gcc 7 lacks. FFmpeg 6.1.2's
# H.264 decoder alone (LGPL-2.1+), built here as static libavcodec /
# libavutil with its x86 assembly (nasm) and linked in: the software
# fallback when the GPU can't decode (the unit's own libavcodec.so.57 has
# AAC decoders only). Pinned by SHA-256 (GitHub's archive of the n6.1.2 tag).
# fonts-dejavu-core + python3-pil: the stop hint, drawn once into a picture
# (tools/make_hint.py). The same base image, pinned to its amd64 manifest, as
# native/hook111/image.
FROM ubuntu:18.04@sha256:dca176c9663a7ba4c1f0e710986f5a25e672842963d95b960191e2d9f7185ebe
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      gcc-8 libc6-dev libssl-dev libopus-dev make nasm curl ca-certificates xz-utils fonts-dejavu-core python3-pil >/dev/null \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/ffmpeg.tar.gz https://github.com/FFmpeg/FFmpeg/archive/refs/tags/n6.1.2.tar.gz \
 && echo "9cbefd67b7e4fffde3846699ec03324b7ef789a81c2e9b1059e93719b5b8d189  /tmp/ffmpeg.tar.gz" | sha256sum -c - \
 && mkdir /tmp/ff && tar -xzf /tmp/ffmpeg.tar.gz -C /tmp/ff --strip-components=1 \
 && cd /tmp/ff && ./configure --prefix=/opt/ffmpeg --cc=gcc-8 --enable-static --disable-shared \
      --disable-autodetect --disable-everything --disable-programs --disable-doc --disable-network \
      --disable-avdevice --disable-avformat --disable-avfilter --disable-swscale --disable-swresample \
      --disable-postproc --enable-decoder=h264 --enable-pthreads >/dev/null \
 && make -s -j"$(nproc)" >/dev/null && make -s install >/dev/null \
 && cp LICENSE.md COPYING.LGPLv2.1 /opt/ffmpeg/ && cd / && rm -rf /tmp/ff /tmp/ffmpeg.tar.gz
WORKDIR /m
