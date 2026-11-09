#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# ANV from Mesa 22.x / 23.x for the unit (image/Dockerfile runs it for a
# MESA_VER of 20 or later; 19.x is built in the Dockerfile itself), on Ubuntu
# 18.04 (glibc 2.27) like the rest:
#   /out/lib/libvulkan_intel.so   ANV, Wayland WSI only
# What the unit's own libraries can't give it is built in, hidden:
# - libdrm 2.4.114, static: ANV calls drmSyncobjTimelineWait and friends
#   (2.4.97+); the unit's libdrm.so.2 has none, and a second libdrm.so.2 in
#   the process would lose to the unit's (i965 loads it first in Wine)
# - Wayland: the unit's libwayland-client is older than 1.17 (no
#   wl_proxy_marshal_flags, no wl_proxy_get_tag): headers and scanner from
#   wayland 1.18.0 (Mesa 22 wants >= 1.18), so the generated code calls only
#   what the unit's library has (checked after the build: image/Dockerfile)
# - zstd off; xmlconfig (drirc) off where Mesa lets it be (23.x), else the
#   unit's libexpat
# The Mesa tree is /src/mesa (unpacked by the Dockerfile).
set -eu
J=$(nproc)
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends python3-pip python3-setuptools libffi-dev libexpat1-dev >/dev/null
pip3 -q install meson==0.61.5
# Mesa 23's generators import dataclasses (Python 3.7); 18.04 has 3.6: the backport
pip3 -q install dataclasses==0.8
MESON=/usr/local/bin/meson
cd /src
# libdrm 2.4.114 (static, PIC), wayland 1.18.0 (scanner, client headers), wayland-protocols 1.32
curl -fsSLO --retry 8 --retry-delay 10 https://dri.freedesktop.org/libdrm/libdrm-2.4.114.tar.xz
curl -fsSLO --retry 8 --retry-delay 10 https://gitlab.freedesktop.org/wayland/wayland/-/releases/1.18.0/downloads/wayland-1.18.0.tar.xz \
  || curl -fsSLO --retry 8 --retry-delay 10 https://wayland.freedesktop.org/releases/wayland-1.18.0.tar.xz
curl -fsSLO --retry 8 --retry-delay 10 https://gitlab.freedesktop.org/wayland/wayland-protocols/-/releases/1.32/downloads/wayland-protocols-1.32.tar.xz
printf '%s\n' "3049cf843a47d12e5eeefbc3be3496d782fa09f42346bf0b7defe3d1e598d026  libdrm-2.4.114.tar.xz" \
    "4675a79f091020817a98fd0484e7208c8762242266967f55a67776936c2e294d  wayland-1.18.0.tar.xz" \
    "7459799d340c8296b695ef857c07ddef24c5a09b09ab6a74f7b92640d2b1ba11  wayland-protocols-1.32.tar.xz" | sha256sum -c -
tar xJf libdrm-2.4.114.tar.xz && tar xJf wayland-1.18.0.tar.xz && tar xJf wayland-protocols-1.32.tar.xz
P=/opt/new
(cd libdrm-2.4.114 && $MESON setup b --prefix=$P --libdir=lib --default-library=static -Db_staticpic=true \
    -Dintel=disabled -Dradeon=disabled -Damdgpu=disabled -Dnouveau=disabled -Dvmwgfx=disabled -Dfreedreno=disabled \
    -Dvc4=disabled -Detnaviv=disabled -Dcairo-tests=disabled -Dman-pages=disabled -Dvalgrind=disabled -Dtests=false >/dev/null \
  && ninja -C b install >/dev/null)
(cd wayland-1.18.0 && $MESON setup b --prefix=$P --libdir=lib -Ddocumentation=false -Ddtd_validation=false >/dev/null \
  && ninja -C b install >/dev/null)
(cd wayland-protocols-1.32 && PATH=$P/bin:$PATH PKG_CONFIG_PATH=$P/lib/pkgconfig $MESON setup b --prefix=$P -Dtests=false >/dev/null \
  && ninja -C b install >/dev/null)
# glslangValidator, at build time only (Mesa 22+ compiles its float64
# shader with it; 18.04 has none): glslang 12.3.1 from source, a pip CMake (3.22: the last for Python 3.6)
python3 -m pip -q install "pip<22" && python3 -m pip -q install cmake==3.22.6
curl -fsSL --retry 8 --retry-delay 10 -o glslang-12.3.1.tar.gz https://github.com/KhronosGroup/glslang/archive/refs/tags/12.3.1.tar.gz
echo "a57836a583b3044087ac51bb0d5d2d803ff84591d55f89087fc29ace42a8b9a8  glslang-12.3.1.tar.gz" | sha256sum -c - || sha256sum glslang-12.3.1.tar.gz
tar xzf glslang-12.3.1.tar.gz
(cd glslang-12.3.1 && /usr/local/bin/cmake -S . -B b -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=$P \
    -DENABLE_OPT=OFF -DENABLE_HLSL=OFF -DENABLE_CTEST=OFF -DBUILD_TESTING=OFF -DENABLE_GLSLANG_BINARIES=ON >/dev/null \
  && ninja -C b install >/dev/null)
export PATH=$P/bin:$PATH PKG_CONFIG_PATH=$P/lib/pkgconfig:$P/share/pkgconfig
cd /src/mesa
# no I915_QUERY: ioctl 0x39 is another call on the unit's kernel (the patch says why)
patch -p1 < /tmp/mesa-no-i915-query.patch
# no context params after PRIORITY (6): the car's kernel has its own (0x7 hung it)
patch -p1 < /tmp/mesa-ctx-params-max-6.patch
OPTS="-Dplatforms=wayland -Dgallium-drivers= -Dvulkan-drivers=intel -Dglx=disabled -Degl=disabled -Dgbm=disabled
  -Dgles1=disabled -Dgles2=disabled -Dopengl=false -Dllvm=disabled -Dvalgrind=disabled -Dlibunwind=disabled
  -Dbuild-tests=false -Dzstd=disabled -Dshared-glapi=disabled -Dvulkan-layers="
# 23.x has the option; 22.x links the unit's libexpat (1.6.7) for drirc instead
case $(cat VERSION) in 2[3-9].*) OPTS="$OPTS -Dxmlconfig=disabled" ;; esac
$MESON setup b --buildtype=release --prefix=/opt/anv --libdir=lib $OPTS
ninja -C b -j"$J" src/intel/vulkan/libvulkan_intel.so
mkdir -p /out/lib
cp b/src/intel/vulkan/libvulkan_intel.so /out/lib/
cp b/src/intel/vulkan/intel_icd.x86_64.json /out/ 2>/dev/null || true
strip --strip-unneeded /out/lib/libvulkan_intel.so
rm -rf b
