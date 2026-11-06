#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Fetches a GE-Proton build (Wine with Proton's patches, as a plain tarball)
# into the Docker volume steam-bench-proton, at /<version>, checked against
# its published SHA-512. Kept inside Docker's Linux VM, never on the Windows
# drive: Windows Defender removed one of Wine's DLLs (GE-Proton10-34's
# i386-windows/iphlpapi.dll) from an unpacked tree there, twice (2026-11-06),
# and the tree needs Linux symlinks anyway.
# The bench runs it with PROTON_USE_WINED3D=1 (OpenGL: the unit has no
# Vulkan) and its Wayland driver (the unit's EGL has no X11 platform).
#   PROTON_VER=GE-Proton11-11 sh tools/fetch_proton.sh   (the default)
# GE-Proton 11 names its assets <ver>-x86_64.*; 10 and older <ver>.*.
set -eu
VER=${PROTON_VER:-GE-Proton11-11}
VOL=steam-bench-proton
export MSYS_NO_PATHCONV=1
docker run --rm -v "$VOL:/p" -e VER="$VER" debian:trixie sh -euc '
    [ -x "/p/$VER/proton" ] && exit 0
    command -v curl >/dev/null || { apt-get -qq -o Acquire::Retries=5 update >/dev/null \
        && apt-get -qq install -y --no-install-recommends curl ca-certificates >/dev/null; }
    URL=https://github.com/GloriousEggroll/proton-ge-custom/releases/download/$VER
    mkdir -p /p/dl && cd /p/dl
    ASSET=
    for a in "$VER-x86_64" "$VER"; do
        if curl -fsSL -o "$a.sha512sum" "$URL/$a.sha512sum" 2>/dev/null; then ASSET=$a; break; fi
    done
    [ -n "$ASSET" ] || { echo "fetch_proton: no release $VER" >&2; exit 1; }
    [ -f "$ASSET.tar.gz" ] || curl -fsSL -o "$ASSET.tar.gz" "$URL/$ASSET.tar.gz"
    [ "$(cut -d" " -f1 "$ASSET.sha512sum")" = "$(sha512sum "$ASSET.tar.gz" | cut -d" " -f1)" ] \
        || { echo "fetch_proton: SHA-512 mismatch for $VER" >&2; exit 1; }
    # its one top directory is named after the asset or the version
    rm -rf "/p/$VER.tmp" && mkdir "/p/$VER.tmp" && tar xzf "$ASSET.tar.gz" -C "/p/$VER.tmp"
    mv /p/$VER.tmp/* "/p/$VER" && rmdir "/p/$VER.tmp"
    # what new WoW64 keeps of lib/wine/i386-unix: only its 64-bit ELF files
    # (ELF class byte 2), mounted over it by run_bench.sh
    W=/p/$VER/files/lib/wine; D=/p/$VER-i386-unix-64only
    rm -rf "$D" && mkdir -p "$D"
    for f in "$W"/i386-unix/*; do
        [ "$(od -A n -t x1 -j 4 -N 1 "$f" | tr -d " ")" = 02 ] && cp -p "$f" "$D/"
    done
    echo "fetch_proton: $VER unpacked; 64-bit files of i386-unix: $(ls "$D" | tr "\n" " ")"'
echo "$VOL:/$VER"
