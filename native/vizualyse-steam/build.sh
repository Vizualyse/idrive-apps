#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Builds what the tool ships besides its scripts (tools/bundle.sh says what
# and why): build/runtime.tgz, build/proton.tgz, build/prefix.tgz,
# build/launch.json, build/bundle-VERSION.txt. In the image from
# image/Dockerfile; the downloads (GE-Proton, .NET, DepotDownloader, checked
# by hash) are kept in the Docker volume steam-build-dl and Proton is unpacked
# only inside the container: never on the Windows drive, where Windows
# Defender removed one of Wine's DLLs (README.md). Kept when its inputs
# haven't changed.
# Each part (vulkan.tgz, iris.tgz, ntdll, the bundle) is keyed on its inputs
# only, and with BUILD_CACHE set (CI: the workflows keep it with
# actions/cache) restored from there instead of built, without building its
# image first (tools/build_cache.sh): a fresh runner rebuilt all of it, ~12
# min, on every Test and Release run.
# Run by the packer (component.json "build"), or by hand:
#   sh native/vizualyse-steam/build.sh
#   sh native/vizualyse-steam/build.sh image | image-name
set -eu
export MSYS_NO_PATHCONV=1   # Git Bash: leave container paths alone
HERE=$(cd "$(dirname "$0")" && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
IMG=idrive-steam-build:trixie-$(sha256sum "$HERE/image/Dockerfile" | cut -c1-8)
[ "${1:-}" = image-name ] && { echo "$IMG"; exit 0; }
# the build image, built when a part needs it
image() {
    docker image inspect $IMG >/dev/null 2>&1 && return 0
    LOG=${TMPDIR:-/tmp}/steam-image.$$.log
    n=1
    # snapshot.debian.org drops downloads now and then: try 3 times
    until docker build --platform linux/amd64 --progress=plain -t $IMG -f "$WIN_HERE/image/Dockerfile" "$WIN_HERE/image" > "$LOG" 2>&1; do
        tail -25 "$LOG" >&2
        [ $n -ge 3 ] && { echo "build.sh: the image did not build in $n tries" >&2; exit 1; }
        n=$((n + 1)); echo "build.sh: image build failed, try $n of 3" >&2; sleep 20
    done
    rm -f "$LOG"
}
[ "${1:-}" = image ] && { image; exit 0; }
node "$WIN_HERE/../../platform/platform.js" sync "$WIN_HERE" >&2   # the pinned platform version's copies (component.json "platform")
. "$HERE/../../tools/build_cache.sh"
mkdir -p "$HERE/build"
# Vulkan for the games (ANV, its loader, DXVK): build/vulkan.tgz (tools/vulkan.sh)
sh "$HERE/tools/vulkan.sh" >&2
# iris for a game's OpenGL (a per-game choice): build/iris.tgz (tools/iris.sh)
sh "$HERE/tools/iris.sh" >&2
# Proton's ntdll.so rebuilt from GE's own Wine tree with
# patches/wine-no-ia32.patch (32-bit programs on the unit's kernel, which has
# no IA32 emulation): tools/build_ntdll.sh in image/wine.Dockerfile, the
# sources in the Docker volume steam-wine-src. Kept while its inputs stay.
nkey=$(cat "$HERE/image/wine.Dockerfile" "$HERE/tools/build_ntdll.sh" "$HERE/patches/wine-no-ia32.patch" | sha256sum | cut -c1-16)
if [ -f "$HERE/build/ntdll-noia32.so" ] && [ "$(cat "$HERE/build/ntdll.key" 2>/dev/null)" = "$nkey" ]; then
    :
elif build_cache_get ntdll "$nkey" "$HERE/build"; then
    echo "$nkey" > "$HERE/build/ntdll.key"
else
    rm -f "$HERE/build/ntdll.key" "$HERE/build/ntdll-noia32.so"
    WIMG=idrive-steam-wine:trixie-$(sha256sum "$HERE/image/wine.Dockerfile" | cut -c1-8)
    docker image inspect $WIMG >/dev/null 2>&1 \
        || docker build -q --platform linux/amd64 -t $WIMG -f "$WIN_HERE/image/wine.Dockerfile" "$WIN_HERE/image" >/dev/null
    docker run --rm --platform linux/amd64 -v steam-wine-src:/w -v "$WIN_HERE:/m" $WIMG \
        sh /m/tools/build_ntdll.sh /m/build/ntdll-noia32.so /m/patches/wine-no-ia32.patch
    echo "$nkey" > "$HERE/build/ntdll.key"
    build_cache_put ntdll "$nkey" "$HERE/build" ntdll-noia32.so
fi
# the bundle: on its inputs only (the image's tag is a hash of its
# Dockerfile; its id, which changes with every rebuild of the same
# Dockerfile, was in the key before and kept a fresh machine from matching)
key=$( (cat "$HERE/image/Dockerfile" "$HERE/tools/bundle.sh" "$HERE"/src/*.c "$HERE"/src/*.h "$HERE"/src/protocol/* \
        "$HERE/build/ntdll-noia32.so"; echo "$IMG") | sha256sum | cut -c1-16)
if [ -f "$HERE/build/proton.tgz" ] && [ -f "$HERE/build/launch.json" ] && [ "$(cat "$HERE/build/bundle.key" 2>/dev/null)" = "$key" ]; then
    echo "vizualyse-steam bundles: up to date ($key)"
    exit 0
fi
rm -f "$HERE/build/bundle.key"
if build_cache_get bundle "$key" "$HERE/build"; then
    echo "$key" > "$HERE/build/bundle.key"
    exit 0
fi
image
# a fixed host name: Wine keeps it in the prefix as the computer's name
docker run --rm --platform linux/amd64 --shm-size=512m --hostname vizualyse -v "$WIN_HERE:/m" -v steam-build-dl:/dl $IMG sh /m/tools/bundle.sh
echo "$key" > "$HERE/build/bundle.key"
build_cache_put bundle "$key" "$HERE/build" runtime.tgz proton.tgz prefix.tgz launch.json bundle-VERSION.txt
