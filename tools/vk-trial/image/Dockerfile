# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# vk-trial's build image (never shipped to the car as such: build.sh packs
# what the trial needs from /out):
#   /out/lib/libvulkan_intel.so  Mesa 19.0.6's ANV, the release of the unit's
#       own i965 (knowledge/browser.md, "Vulkan on this kernel"), built on
#       glibc 2.27 like the unit. Wayland WSI (no X11). MESA_VER=19.1.8 for
#       a trial of the next one (below).
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
      libwayland-dev libwayland-bin wayland-protocols \
      libvulkan1=1.1.70+dfsg1-1ubuntu0.18.04.1 libvulkan-dev=1.1.70+dfsg1-1ubuntu0.18.04.1 >/dev/null \
 && rm -rf /var/lib/apt/lists/*
# Mesa's release tarball (19.0.6: the same as tools/gpu-bench's), sha256
# checked. The Steam tool's release builds this image in CI, so it needs
# nothing local (archive.mesa3d.org was very slow once: retries).
# MESA_VER (build.sh passes it): 19.0.6, what Steam ships, or 19.1.8, the
# first ANV with VK_EXT_external_memory_host (32-bit DXVK under new WoW64)
# and VK_EXT_host_query_reset (DXVK 1.10.x): knowledge/games.md, "Vulkan".
ARG MESA_VER=19.0.6
RUN case $MESA_VER in \
      19.0.6) sha=2db2f2fcaa4048b16e066fad76b8a93944f7d06d329972b0f5fd5ce692ce3d24 ;; \
      19.1.8) sha=f0fe8289b7d147943bf2fc2147833254881577e8f9ed3d94ddb39e430e711725 ;; \
      19.3.5) sha=009895b055b971c82d7a0cd57227d414d323282605946e94e9b308a9cb49c6b6 ;; \
      22.3.7) sha=894ce2f4a1c2e76177cdd2284620192d0da3066b243eec2fbb1d7cf37f13042c ;; \
      23.1.9) sha=295ba27c28146ed09214e8ce79afa1659edf9d142decc3c91f804552d64f7510 ;; \
      *) echo "no sha256 for Mesa $MESA_VER"; exit 1 ;; \
    esac \
 && mkdir -p /src && cd /src \
 && { curl -fsSLO --retry 8 --retry-delay 10 https://archive.mesa3d.org/older-versions/${MESA_VER%%.*}.x/mesa-$MESA_VER.tar.xz \
      || curl -fsSLO --retry 8 --retry-delay 10 https://archive.mesa3d.org/mesa-$MESA_VER.tar.xz; } \
 && echo "$sha  mesa-$MESA_VER.tar.xz" | sha256sum -c - \
 && tar xJf mesa-$MESA_VER.tar.xz && rm mesa-$MESA_VER.tar.xz && mv mesa-$MESA_VER mesa \
 && mkdir -p /out/licenses \
 && { cp mesa/docs/license.html /out/licenses/mesa.html 2>/dev/null || cp mesa/docs/license.rst /out/licenses/mesa.rst; } \
 && cp /usr/share/doc/libvulkan1/copyright /out/licenses/vulkan-loader.txt
# ANV only. platforms=drm is the least Mesa 19 accepts; it brings
# VK_KHR_display, which opens the primary node (card0, Winston's) only when
# an instance enables it: the probe never does, and the gate hides
# /dev/dri/card* from the child whatever asks. wayland adds
# VK_KHR_wayland_surface: frames to a Wayland compositor as wl_drm PRIME
# buffers (or dmabuf), linking the unit's own libwayland-client.so.0.
# 19.1 wants meson >= 0.46 (18.04 has 0.45: the pip one, installed here for
# it, as for Wayland below) and its generated xmlpool/options.h built first
# (missing from the newer meson's dependency order: "No such file").
# Mesa 22.x / 23.x (Vulkan 1.3, for DXVK 2.x): image/anv_new.sh, its own
# way (libdrm built in, wayland 1.18's scanner, glslang at build time).
COPY anv_new.sh mesa-no-i915-query.patch /tmp/
RUN case $MESA_VER in 19.*) exit 0 ;; esac \
 && sh /tmp/anv_new.sh \
 && cp -L /usr/lib/x86_64-linux-gnu/libvulkan.so.1 /out/lib/
RUN case $MESA_VER in 19.*) ;; *) exit 0 ;; esac \
 && cd /src/mesa \
 && if [ "$MESA_VER" = 19.0.6 ]; then MESON=meson; else \
      apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends python3-pip python3-setuptools >/dev/null \
      && pip3 -q install meson==0.61.5 && MESON=/usr/local/bin/meson; fi \
 && $MESON b --buildtype=release --prefix=/opt/anv --libdir=lib \
      -Dplatforms=drm,wayland -Ddri-drivers= -Dgallium-drivers= -Dvulkan-drivers=intel \
      -Dglx=disabled -Degl=false -Dgbm=false -Dgles1=false -Dgles2=false -Dopengl=false \
      -Dllvm=false -Dvalgrind=false -Dlibunwind=false -Dbuild-tests=false >/dev/null \
 && { [ "$MESA_VER" = 19.0.6 ] || ninja -C b src/util/xmlpool/options.h >/dev/null; } \
 && ninja -C b install >/dev/null \
 && mkdir -p /out/lib && cp /opt/anv/lib/libvulkan_intel.so /out/lib/ \
 && strip --strip-unneeded /out/lib/libvulkan_intel.so \
 && cp -L /usr/lib/x86_64-linux-gnu/libvulkan.so.1 /out/lib/ \
 && rm -rf b
COPY --from=spv /src/shaders.spv.h /out/
# libwayland 1.22 for wl-sink only (the present stage's compositor, the Steam
# tool's source): it uses wl_output 4 and newer xdg-shell, which need a
# libwayland-server >= 1.20 (and it is a client of Winston too); the unit's
# is older, and 18.04's 1.16. Shipped in lib/wl/ (server and client), found
# through wl-sink's RUNPATH only: ANV and vkprobe keep the unit's own
# libwayland-client. /opt/wlp: wayland-protocols 1.32's XML.
RUN DEBIAN_FRONTEND=noninteractive apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends python3-pip python3-setuptools libffi-dev >/dev/null \
 && rm -rf /var/lib/apt/lists/* && pip3 -q install meson==0.61.5 \
 && cd /src && curl -fsSLO --retry 5 --retry-delay 5 https://gitlab.freedesktop.org/wayland/wayland/-/releases/1.22.0/downloads/wayland-1.22.0.tar.xz \
 && curl -fsSLO --retry 5 --retry-delay 5 https://gitlab.freedesktop.org/wayland/wayland-protocols/-/releases/1.32/downloads/wayland-protocols-1.32.tar.xz \
 && printf '%s\n' "1540af1ea698a471c2d8e9d288332c7e0fd360c8f1d12936ebb7e7cbc2425842  wayland-1.22.0.tar.xz" \
      "7459799d340c8296b695ef857c07ddef24c5a09b09ab6a74f7b92640d2b1ba11  wayland-protocols-1.32.tar.xz" | sha256sum -c - \
 && tar xJf wayland-1.22.0.tar.xz && tar xJf wayland-protocols-1.32.tar.xz && mkdir -p /opt/wlp \
 && cp -r wayland-protocols-1.32/stable wayland-protocols-1.32/staging wayland-protocols-1.32/unstable /opt/wlp/ \
 && cd wayland-1.22.0 && /usr/local/bin/meson setup b --prefix=/opt/wl --libdir=lib -Ddocumentation=false -Dtests=false -Ddtd_validation=false >/dev/null \
 && ninja -C b install >/dev/null && mkdir -p /out/lib/wl \
 && cp -L /opt/wl/lib/libwayland-server.so.0 /opt/wl/lib/libwayland-client.so.0 /out/lib/wl/ && strip --strip-unneeded /out/lib/wl/* \
 && cd /src && rm -rf wayland-1.22.0* wayland-protocols-1.32*
# Nothing may need more than the unit's glibc 2.27.
RUN for f in /out/lib/*; do \
      v=$(objdump -T "$f" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1); \
      echo "$f: $v"; [ "$(printf '%s\nGLIBC_2.27\n' "$v" | sort -V | tail -1)" = GLIBC_2.27 ] || exit 1; \
    done && readelf -d /out/lib/libvulkan_intel.so | grep NEEDED
WORKDIR /m
