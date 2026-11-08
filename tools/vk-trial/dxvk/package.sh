#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# build/vk-trial-dxvk.tgz: DXVK under Proton through vk-trial's gate on the
# car, unpacked into /var/opt/vk-trial beside vk-trial.tgz:
#   dxvk/run.js           the launcher (setup as root; run as the gate's child)
#   dxvk/win/*.exe        the test programs (t_d3d11, the Steam bench's t_d3d9)
#   dxvk/dxvk/{x64,x32}   DXVK's DLLs (DXVK_VER, 1.9.4 by default), VERSION
# Assembled in a container from the volume vk-trial-dxvk (Wine DLLs never
# unpacked on the Windows drive). Builds what's missing (dxvk/bench.sh's
# steps: DXVK into the volume, the test programs).
#   sh tools/vk-trial/dxvk/package.sh
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")" && pwd)
VKT=$(cd "$HERE/.." && pwd)
win() { (cd "$1" && (pwd -W 2>/dev/null || pwd)); }
DXVK_VER=${DXVK_VER:-1.9.4}
[ -f "$VKT/build/dxvk-win/t_d3d1164.exe" ] && [ -f "$VKT/build/dxvk-win/t_d3d932.exe" ] && [ -f "$VKT/build/dxvk-win/t_d3d1132.exe" ] \
    && docker run --rm -v vk-trial-dxvk:/d alpine test -d "/d/dxvk-$DXVK_VER" 2>/dev/null \
    || { echo "dxvk package: running dxvk/bench.sh first (DXVK, the test programs)" >&2; DXVK_VER=$DXVK_VER sh "$HERE/bench.sh" >&2; }
docker run --rm -v vk-trial-dxvk:/d:ro -v "$(win "$HERE"):/s:ro" -v "$(win "$VKT/build"):/o" "$(cat "$VKT/build/image")" sh -ec "
    rm -rf /tmp/p && mkdir -p /tmp/p/dxvk/win /tmp/p/dxvk/dxvk
    cp /s/run.js /tmp/p/dxvk/
    cp /o/dxvk-win/t_d3d1164.exe /o/dxvk-win/t_d3d964.exe /o/dxvk-win/t_d3d932.exe /o/dxvk-win/t_d3d1132.exe /tmp/p/dxvk/win/
    cp -r /d/dxvk-$DXVK_VER/x64 /d/dxvk-$DXVK_VER/x32 /tmp/p/dxvk/dxvk/
    echo $DXVK_VER > /tmp/p/dxvk/dxvk/VERSION
    find /tmp/p -type d -exec chmod 755 {} +; find /tmp/p -type f -exec chmod 644 {} +
    cd /tmp/p && tar --owner=0 --group=0 --mtime=@0 --sort=name -czf /o/vk-trial-dxvk.tgz dxvk
    tar tzf /o/vk-trial-dxvk.tgz | wc -l"
echo "dxvk package: build/vk-trial-dxvk.tgz (DXVK $DXVK_VER)"
