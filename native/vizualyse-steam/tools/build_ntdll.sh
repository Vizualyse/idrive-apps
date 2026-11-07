#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Rebuilds Proton's lib/wine/x86_64-unix/ntdll.so from GE-Proton's own Wine
# tree, with PATCH applied if given (patches/wine-no-ia32.patch: 32-bit
# programs on a kernel without IA32 emulation, knowledge/games.md).
# Runs in image/wine.Dockerfile with the Docker volume steam-wine-src at /w
# (sources and build, never on the Windows drive):
#   sh tools/build_ntdll.sh OUT [PATCH]
# The tree is GE's tag GE-Proton11-11: Valve's Wine at the submodule's commit,
# Wine Staging at its commit, and GE's own Wine section of
# patches/protonprep-valve-staging.sh (applied as GE does). It is made once
# (/w/ge/.prepared); a patch is applied to a fresh copy of it.
set -eu
OUT=$1
PATCH=${2:-}
TAG=GE-Proton11-11
GE=/w/ge
if [ ! -f $GE/.prepared ]; then
    rm -rf $GE
    git clone -q --depth 1 --branch $TAG https://github.com/GloriousEggroll/proton-ge-custom $GE
    cd $GE
    git submodule update -q --init --depth 1 wine wine-staging
    git -C wine log -1 --format='wine %H'
    git -C wine-staging log -1 --format='wine-staging %H'
    # GE's helpers, its wineopenxr prep and its whole Wine section, unchanged
    S=patches/protonprep-valve-staging.sh
    { sed -n '1,15p' $S
      sed -n '/^    pushd wineopenxr$/,/^    popd$/p' $S
      sed -n '/^### (2) WINE PATCHING ###$/,/^### END WINE PATCHING ###$/p' $S
    } > /w/wine-section.sh
    # the commits it reverts (and their parents): not in a shallow clone
    for c in $(sed -n 's/^ *git revert --no-commit \([0-9a-f]\{40\}\).*/\1/p' /w/wine-section.sh); do
        git -C wine fetch -q --depth 2 origin "$c"
    done
    git config --global user.email build@localhost
    git config --global user.name build
    bash -e /w/wine-section.sh > /w/wine-section.log 2>&1 || { tail -30 /w/wine-section.log; exit 1; }
    grep -c '^patching file' /w/wine-section.log | sed 's/^/patched files: /'
    touch $GE/.prepared
fi
# the tree to build: GE's, plus the patch on a copy
SRC=/w/src
rm -rf $SRC /w/build
cp -a $GE/wine $SRC
if [ -n "$PATCH" ]; then
    (cd $SRC && patch -Np1 --no-backup-if-mismatch < "$PATCH")
fi
# what Proton's Makefile.in does after the source (.wine-post-source): the
# generated Vulkan headers and thunks (from the tree's vk.xml), spec files
(cd $SRC && XDG_CACHE_HOME=/w/cache python3 dlls/winevulkan/make_vulkan -x vk.xml -X video.xml > /w/make_vulkan.log 2>&1 \
    || { tail -20 /w/make_vulkan.log; exit 1; })
(cd $SRC && tools/make_specfiles > /dev/null 2>&1 || true)
mkdir -p /w/build && cd /w/build
# 64-bit only (new WoW64 needs no 32-bit host build), no X11 / GUI libraries:
# ntdll.so needs only libc and libgcc_s, as the shipped one
# (no PE cross-compiler: ntdll.so is the Unix side); Proton's own flags
# (its Makefile.in: x86_64_CFLAGS and CFLAGS)
export CFLAGS="-mcmodel=small -march=nocona -mtune=core-avx2 -mfpmath=sse -O2 -fwrapv -fno-strict-aliasing -ggdb -ffunction-sections -fdata-sections -fno-omit-frame-pointer"
$SRC/configure -q --enable-win64 --without-mingw --without-x \
    --without-freetype --without-gnutls --without-alsa --without-pulse --without-dbus \
    --without-wayland --without-sdl \
    --without-udev --without-usb --without-v4l2 --without-cups --without-sane --without-krb5 \
    --without-pcap --without-netapi --without-unwind --without-capi --without-gphoto \
    --without-ffmpeg --without-xinerama > /w/configure.log 2>&1 \
    || { tail -30 /w/configure.log; exit 1; }
make -s -j"$(nproc)" __tooldeps__ > /w/make.log 2>&1 || { tail -30 /w/make.log; exit 1; }
make -s -j"$(nproc)" dlls/ntdll/ntdll.so >> /w/make.log 2>&1 || { tail -30 /w/make.log; exit 1; }
cp dlls/ntdll/ntdll.so "$OUT"
ls -la "$OUT"
