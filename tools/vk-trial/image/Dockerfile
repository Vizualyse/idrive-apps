# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# vk-trial's build image (never shipped to the car as such: build.sh packs
# what the trial needs from /out):
#   /out/lib/libvulkan_intel.so  Mesa 19.0.6's ANV, the release of the unit's
#       own i965 (knowledge/browser.md, "Vulkan on this kernel"), built on
#       glibc 2.27 like the unit. No X11 / Wayland WSI.
#   /out/lib/libvulkan.so.1      Ubuntu 18.04's Khronos loader 1.1.70 (the
#       unit has none).
#   /out/shaders.spv.h           the probe's shaders: compute, draw (glslang, below).
# Plus strace, for the test that the gate's first syscall is the disarm.

# The shader only: 18.04 has no glslang.
FROM debian:bookworm-20241016-slim@sha256:36e591f228bb9b99348f584e83f16e012c33ba5cad44ef5981a1d7c0a93eca22 AS spv
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends glslang-tools spirv-tools >/dev/null
COPY compute.comp draw.vert draw.frag /src/
RUN cd /src && for s in compute.comp draw.vert draw.frag; do \
      n=$(echo $s | tr . _)_spv; \
      glslangValidator --target-env vulkan1.0 -V --vn $n -o $n.h $s \
      && glslangValidator --target-env vulkan1.0 -V -o $n.spv $s && spirv-val --target-env vulkan1.0 $n.spv || exit 1; \
    done && cat compute_comp_spv.h draw_vert_spv.h draw_frag_spv.h > /src/shaders.spv.h

FROM ubuntu:18.04@sha256:dca176c9663a7ba4c1f0e710986f5a25e672842963d95b960191e2d9f7185ebe
ENV LC_ALL=C.UTF-8
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      ca-certificates curl xz-utils pkg-config gcc g++ make python3 python3-mako ninja-build flex bison \
      gettext libexpat1-dev zlib1g-dev libdrm-dev meson strace \
      libvulkan1=1.1.70+dfsg1-1ubuntu0.18.04.1 libvulkan-dev=1.1.70+dfsg1-1ubuntu0.18.04.1 >/dev/null \
 && rm -rf /var/lib/apt/lists/*
# Mesa 19.0.6's source from the GPU bench's image (build.sh passes it as the
# build context "gpubench"): unpacked there from the release tarball after
# its sha256 check, so no second download (archive.mesa3d.org can be very
# slow), and the same source as the bench's swrast.
COPY --from=gpubench /src/mesa-19.0.6 /src/mesa-19.0.6
# ANV only. platforms=drm is the least Mesa 19 accepts; it brings
# VK_KHR_display, which opens the primary node (card0, Winston's) only when
# an instance enables it: the probe never does, and vk_crumbs.so refuses
# /dev/dri/card* whatever asks.
RUN cd /src/mesa-19.0.6 \
 && meson b --buildtype=release --prefix=/opt/anv --libdir=lib \
      -Dplatforms=drm -Ddri-drivers= -Dgallium-drivers= -Dvulkan-drivers=intel \
      -Dglx=disabled -Degl=false -Dgbm=false -Dgles1=false -Dgles2=false -Dopengl=false \
      -Dllvm=false -Dvalgrind=false -Dlibunwind=false -Dbuild-tests=false >/dev/null \
 && ninja -C b install >/dev/null \
 && mkdir -p /out/lib && cp /opt/anv/lib/libvulkan_intel.so /out/lib/ \
 && strip --strip-unneeded /out/lib/libvulkan_intel.so \
 && cp -L /usr/lib/x86_64-linux-gnu/libvulkan.so.1 /out/lib/ \
 && rm -rf b
COPY --from=spv /src/shaders.spv.h /out/
# Nothing may need more than the unit's glibc 2.27.
RUN for f in /out/lib/*; do \
      v=$(objdump -T "$f" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1); \
      echo "$f: $v"; [ "$(printf '%s\nGLIBC_2.27\n' "$v" | sort -V | tail -1)" = GLIBC_2.27 ] || exit 1; \
    done && readelf -d /out/lib/libvulkan_intel.so | grep NEEDED
WORKDIR /m
