# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# The GPU bench's build image: the two stand-ins for the head unit's GPU that
# let the unit's own Mesa 19.0.6 userspace (libEGL, libgbm, libGLESv2,
# libglapi, i965_dri.so from ../idrive-rootfs) run in its rootfs container,
# which has no GPU (README.md says what each one shows and doesn't).
#
#   /out/stub/libintel_noop_drm_shim.so  Mesa 22.3.7's Intel no-op DRM shim:
#       preloaded, it fakes /dev/dri/renderD128 and answers i915's ioctls as
#       an Apollo Lake HD Graphics 505 (0x5A84, the unit's chip), running
#       nothing. The unit's real i965 then loads, compiles and "draws".
#   /out/swrast/swrast_dri.so  Mesa 19.0.6's gallium swrast (llvmpipe and
#       softpipe, LLVM 6 linked in statically): the same Mesa release as the
#       unit, so the unit's libglapi / libEGL / libgbm load it, and it draws
#       real pixels on the CPU.
#   /opt/mesa19  headers and link stubs to build test programs against.
#
# Ubuntu 18.04: glibc 2.27, the unit's. Never shipped to the car.
FROM ubuntu:18.04@sha256:dca176c9663a7ba4c1f0e710986f5a25e672842963d95b960191e2d9f7185ebe
ENV LC_ALL=C.UTF-8
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      ca-certificates curl xz-utils pkg-config gcc g++ make patch python3 python3-pip python3-setuptools \
      python3-mako ninja-build flex bison gettext libexpat1-dev zlib1g-dev libdrm-dev llvm-6.0-dev meson >/dev/null \
 && rm -rf /var/lib/apt/lists/* \
 && pip3 -q install meson==0.61.5 && /usr/local/bin/meson --version && /usr/bin/meson --version
RUN mkdir -p /src && cd /src \
 && curl -fsSLO https://archive.mesa3d.org/older-versions/19.x/mesa-19.0.6.tar.xz \
 && curl -fsSLO https://archive.mesa3d.org/older-versions/22.x/mesa-22.3.7.tar.xz \
 && curl -fsSLO https://dri.freedesktop.org/libdrm/libdrm-2.4.114.tar.xz \
 && printf '%s\n' \
      "2db2f2fcaa4048b16e066fad76b8a93944f7d06d329972b0f5fd5ce692ce3d24  mesa-19.0.6.tar.xz" \
      "894ce2f4a1c2e76177cdd2284620192d0da3066b243eec2fbb1d7cf37f13042c  mesa-22.3.7.tar.xz" \
      "3049cf843a47d12e5eeefbc3be3496d782fa09f42346bf0b7defe3d1e598d026  libdrm-2.4.114.tar.xz" \
    | sha256sum -c - \
 && for f in *.tar.xz; do tar xJf "$f"; done && rm *.tar.xz

# Mesa 19.0.6 (Ubuntu's meson 0.45, /usr/bin; the newer sources use pip's
# 0.61 in /usr/local/bin): swrast only, for the drm (GBM) platform like the
# unit's EGL. Its libEGL / libgbm / libGLESv2 are only link stubs: at run
# time the unit's own load.
RUN cd /src/mesa-19.0.6 \
 && /usr/bin/meson b --buildtype=release --prefix=/opt/mesa19 --libdir=lib \
      -Dplatforms=drm -Ddri-drivers= -Dgallium-drivers=swrast -Dvulkan-drivers= \
      -Dglx=disabled -Degl=true -Dgbm=true -Dgles1=false -Dgles2=true -Dshared-glapi=true \
      -Dllvm=true -Dshared-llvm=false -Dvalgrind=false -Dlibunwind=false \
      -Dgallium-xa=false -Dgallium-vdpau=false -Dgallium-xvmc=false -Dgallium-omx=disabled \
      -Dgallium-va=false -Dgallium-nine=false -Dgallium-opencl=disabled -Dosmesa=none \
      -Dbuild-tests=false >/dev/null \
 && ninja -C b install >/dev/null \
 && mkdir -p /out/swrast && cp /opt/mesa19/lib/dri/swrast_dri.so /out/swrast/ \
 && strip --strip-unneeded /out/swrast/swrast_dri.so \
 && cp /lib/x86_64-linux-gnu/libtinfo.so.5 /out/swrast/ \
 && rm -rf b

# The shim needs a newer libdrm's headers than 18.04's 2.4.101 (Mesa 22.3
# asks for 2.4.109); at run time it uses the unit's libdrm.so.2.
RUN cd /src/libdrm-2.4.114 \
 && /usr/local/bin/meson setup b --prefix=/opt/libdrm \
      -Dintel=disabled -Damdgpu=disabled -Dradeon=disabled -Dnouveau=disabled -Dvmwgfx=disabled \
      -Dfreedreno=disabled -Dvc4=disabled -Detnaviv=disabled -Dexynos=disabled -Domap=disabled \
      -Dtegra=disabled -Dcairo-tests=disabled -Dvalgrind=disabled -Dman-pages=disabled -Dtests=false >/dev/null \
 && ninja -C b install >/dev/null && rm -rf b

# Mesa 22.3.7's no-op shim, the last release that builds it without libclc /
# LLVM. Its platform name "bxt" means 0x5A85 (HD Graphics 500, 2x6); the unit
# is a 505 (3x6, 18 EUs), so it is made 0x5A84. The patch adds the ioctls
# Mesa 19's i965 uses and the shim lacks: GEM_PWRITE / GEM_PREAD (buffer
# uploads, kept in the BO) and GEM_THROTTLE (a no-op).
# drm-shim-new-glibc-stat.patch: built on glibc 2.27 the shim catches only
# __xstat / __fxstat; it also gets stat / fstat / stat64 / fstat64, which
# libraries built on glibc >= 2.33 call (a newer libdrm in Proton's userland or
# the browser's bundle: "MESA-LOADER: failed to retrieve device information"),
# and access(), by which a newer libdrm tells a render node from a primary one
# (else Mesa's Wayland EGL fails at "drmGetMagic").
COPY intel-noop-shim-pread-pwrite.patch drm-shim-new-glibc-stat.patch /src/
RUN cd /src/mesa-22.3.7 \
 && patch -p1 < /src/intel-noop-shim-pread-pwrite.patch \
 && patch -p1 < /src/drm-shim-new-glibc-stat.patch \
 && grep -q '{ "bxt", 0x5A85 }' src/intel/dev/intel_device_info.c \
 && sed -i 's/{ "bxt", 0x5A85 }/{ "bxt", 0x5A84 }/' src/intel/dev/intel_device_info.c \
 && PKG_CONFIG_PATH=/opt/libdrm/lib/x86_64-linux-gnu/pkgconfig \
      /usr/local/bin/meson setup b -Dbuildtype=release \
      -Dgallium-drivers=iris -Dvulkan-drivers= -Dtools=drm-shim,intel \
      -Dplatforms= -Dglx=disabled -Degl=disabled -Dgbm=disabled -Dgles1=disabled -Dgles2=disabled \
      -Dllvm=disabled -Dshared-llvm=disabled -Dvalgrind=disabled -Dlibunwind=disabled -Dzstd=disabled \
      -Dshader-cache=disabled -Dbuild-tests=false >/dev/null \
 && ninja -C b src/intel/tools/libintel_noop_drm_shim.so >/dev/null \
 && mkdir -p /out/stub && cp b/src/intel/tools/libintel_noop_drm_shim.so /out/stub/ \
 && strip --strip-unneeded /out/stub/libintel_noop_drm_shim.so \
 && for s in __xstat __fxstat stat fstat stat64 fstat64 access; do \
      nm -D --defined-only /out/stub/libintel_noop_drm_shim.so | grep -q " T $s\$" \
        || { echo "shim lacks $s"; exit 1; }; done \
 && rm -rf b

# What the stand-ins may need from glibc: no more than the unit's 2.27.
RUN for f in /out/*/*.so*; do \
      v=$(objdump -T "$f" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1); \
      echo "$f: $v"; [ "$(printf '%s\nGLIBC_2.27\n' "$v" | sort -V | tail -1)" = GLIBC_2.27 ] || exit 1; \
    done
WORKDIR /m
