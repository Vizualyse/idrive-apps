#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# DXVK under Proton on the unit's Vulkan, off the car: the Steam tool's bench
# (its trixie image, GE-Proton in the volume steam-bench-proton) with
# Direct3D going to DXVK instead of WineD3D, on vk-trial's ANV with
# gpu-bench's stub GPU behind kernel414 (the unit's kernel's answers),
# presenting through Wine's Wayland driver into vk-trial's wl-sink (wl_drm
# buffers read back through the unit's i965).
# Which DXVK: ANV 19.0.6 is Vulkan 1.1, so not 2.x or GE-Proton's own 3.1
# (Vulkan 1.3). 1.10.x wants VK_EXT_host_query_reset at every feature level
# (Mesa 19.1+, not ours: "Requested feature level not supported", seen
# here); DXVK_VER=1.9.4 (the default) is the last without it, transform
# feedback from 10_0 (ANV 19.0 has it).
# The DXVK is mounted over Proton's own dxvk folder (read-only), so Proton
# installs it into the prefix as it would its own; nothing of the Steam tool
# or of the volume is changed.
#   sh tools/vk-trial/dxvk/bench.sh [PROGRAM.exe ...]   (default: t_d3d11)
# Output and logs: tools/vk-trial/build/dxvk-out (DXVK's logs, Proton's,
# wl-sink's, the crumbs). The prefix is kept in the volume vk-trial-dxvk-pfx.
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")" && pwd)
VKT=$(cd "$HERE/.." && pwd)
STEAM=$(cd "$VKT/../../native/vizualyse-steam" && pwd)
win() { (cd "$1" && (pwd -W 2>/dev/null || pwd)); }
PROTON_VER=${PROTON_VER:-GE-Proton11-11}
DXVK_VER=${DXVK_VER:-1.9.4}
case $DXVK_VER in   # sha256 of the release tarballs, as first downloaded (2026-11-07)
    1.9.4) DXVK_SHA=854f564c3b58a4cdf7b16eb9a4b6bc6ddc0f83d68c4f979a529fc23f7a770502 ;;
    1.10.3) DXVK_SHA=8d1a3c912761b450c879f98478ae64f6f6639e40ce6848170a0f6b8596fd53c6 ;;
    *) echo "dxvk bench: no hash for DXVK $DXVK_VER" >&2; exit 2 ;;
esac
DX=dxvk-$DXVK_VER

sh "$VKT/build.sh" >&2
docker image inspect idrive-steam-bench:trixie >/dev/null 2>&1 \
    || docker build -q -f "$STEAM/image/bench.Dockerfile" -t idrive-steam-bench:trixie "$STEAM/image" >/dev/null
[ -f "$STEAM/build/unit-gl/dri/i965_dri.so" ] || sh "$STEAM/tools/unit_gl.sh" >&2
PROTON_VER=$PROTON_VER sh "$STEAM/tools/fetch_proton.sh" >/dev/null

# DXVK, in a volume (Wine's DLLs off the Windows drive: Defender)
docker volume create vk-trial-dxvk >/dev/null
docker run --rm -v vk-trial-dxvk:/d "$(cat "$VKT/build/image")" sh -ec "
    cd /d; [ -f $DX.tar.gz ] || curl -fsSL --retry 3 -o $DX.tar.gz https://github.com/doitsujin/dxvk/releases/download/v$DXVK_VER/$DX.tar.gz
    echo '$DXVK_SHA  $DX.tar.gz' | sha256sum -c - >/dev/null
    [ -d $DX ] || tar xzf $DX.tar.gz"
# what goes over Proton's dxvk folder: DXVK's DLLs and Proton's own
# openvr_api_dxvk.dll (an OpenVR shim Proton always copies; not rendering)
docker run --rm -v vk-trial-dxvk:/d -v steam-bench-proton:/proton:ro "$(cat "$VKT/build/image")" sh -ec "
    P=/proton/$PROTON_VER/files/lib/wine/dxvk
    rm -rf /d/proton && mkdir -p /d/proton/x86_64-windows /d/proton/i386-windows
    cp /d/$DX/x64/*.dll \$P/x86_64-windows/openvr_api_dxvk.dll /d/proton/x86_64-windows/
    cp /d/$DX/x32/*.dll \$P/i386-windows/openvr_api_dxvk.dll /d/proton/i386-windows/"

# the test programs (mingw, the Steam bench's image; its tlog.h)
mkdir -p "$VKT/build/dxvk-win" "$VKT/build/dxvk-out"
docker image inspect idrive-steam-mingw:trixie >/dev/null 2>&1 \
    || docker build -q -f "$STEAM/image/mingw.Dockerfile" -t idrive-steam-mingw:trixie "$STEAM/image" >/dev/null
docker run --rm -v "$(win "$HERE/win"):/src:ro" -v "$(win "$STEAM/test/win"):/tlog:ro" -v "$(win "$VKT/build/dxvk-win"):/out" \
    idrive-steam-mingw:trixie sh -ec '
    for c in /src/*.c /tlog/t_d3d9.c; do   # ours and the Steam bench'"'"'s Direct3D 9 check
        t=$(basename "$c" .c); libs=$(sed -n "s#^ \* libs: ##p" "$c")
        x86_64-w64-mingw32-gcc -O2 -Wall -Werror -mwindows -I/tlog -o /out/${t}64.exe "$c" $libs
        # and 32-bit (Wine'"'"'s WoW64, DXVK'"'"'s x32 DLLs)
        i686-w64-mingw32-gcc -O2 -Wall -Werror -mwindows -I/tlog -o /out/${t}32.exe "$c" $libs
    done'

[ $# -gt 0 ] || set -- t_d3d11 t_d3d9
progs=
for p in "$@"; do p=${p%.exe}; case $p in *64) ;; *) p=${p}64 ;; esac; progs="$progs /w/$p.exe"; done
NAME=vk-trial-dxvk-$$
trap 'docker rm -f $NAME >/dev/null 2>&1' EXIT INT TERM
D=/proton/$PROTON_VER/files/lib/wine/dxvk
# shellcheck disable=SC2086
docker run --rm --name $NAME --network none --shm-size=512m \
    -v steam-bench-proton:/proton:ro \
    --mount type=volume,src=vk-trial-dxvk,dst=$D/x86_64-windows,volume-subpath=proton/x86_64-windows,readonly \
    --mount type=volume,src=vk-trial-dxvk,dst=$D/i386-windows,volume-subpath=proton/i386-windows,readonly \
    -v "vk-trial-dxvk-pfx-$PROTON_VER-$DXVK_VER:/pfx" -e PROTON="/proton/$PROTON_VER" \
    -v "$(win "$VKT/../gpu-bench/build"):/g:ro" -v "$(win "$VKT/build"):/v:ro" -v "$(win "$STEAM/build/unit-gl"):/ugl:ro" \
    -v "$(win "$VKT/build/dxvk-win"):/w:ro" -v "$(win "$VKT/build/dxvk-out"):/o" -v "$(win "$HERE"):/s:ro" \
    ${T_TIMEOUT:+-e T_TIMEOUT="$T_TIMEOUT"} ${WINEDEBUG:+-e WINEDEBUG="$WINEDEBUG"} ${DOCKER_ARGS:-} \
    idrive-steam-bench:trixie sh /s/in_bench.sh $progs
