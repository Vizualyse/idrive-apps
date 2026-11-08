#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Inside the Steam bench's container (bench.sh mounts everything): wl-sink,
# then each Windows program through Proton with DXVK 1.10.3 on vk-trial's
# ANV (gpu-bench's stub GPU, kernel414), Wine's Wayland driver presenting
# into wl-sink. As on the car: ANV's own Vulkan loader (vk-trial's lib/,
# 1.1.70) ahead of the image's, ANV named only through VK_ICD_FILENAMES.
#   in_bench.sh PROGRAM.exe ...
# Prints each program's lines (T_LOG), "== NAME: exit N in S s", DXVK's
# adapter lines and Wine's errors; everything kept in /o.
set -u
PROTON=${PROTON:-/proton/GE-Proton11-11}
export XDG_RUNTIME_DIR=/tmp/xdg
mkdir -p -m 700 "$XDG_RUNTIME_DIR" /tmp/log /tmp/steam
# vk-trial's programs are linked for the unit's loader path
[ -e /lib/ld-linux-x86-64.so.2 ] || ln -s /lib64/ld-linux-x86-64.so.2 /lib/ld-linux-x86-64.so.2

STUB="/v/bench/kernel414.so:/g/stub/libintel_noop_drm_shim.so"
export INTEL_STUB_GPU_PLATFORM=bxt

# wl-sink: vk-trial's (glibc 2.27, its libwayland-server 1.22), the unit's
# EGL / i965 on the stub for the wl_drm buffers
# (the unit's libffi.so.6 from /v/unitlib: our libwayland-server needs it, the unit has it, trixie doesn't)
LD_PRELOAD=$STUB LD_LIBRARY_PATH=/v/pkg/lib:/ugl/lib:/v/unitlib LIBGL_DRIVERS_PATH=/ugl/dri \
    /v/pkg/bin/wl-sink --socket wayland-1 --frame /tmp/frame --create 640x360 --snap /o/snap.ppm >/tmp/log/wl-sink.log 2>&1 &
SINK=$!
i=0
while [ ! -S "$XDG_RUNTIME_DIR/wayland-1" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
[ -S "$XDG_RUNTIME_DIR/wayland-1" ] || { echo "dxvk bench: wl-sink did not start"; cat /tmp/log/wl-sink.log; exit 1; }
head -1 /tmp/log/wl-sink.log

# ANV, reachable only through this environment
printf '{"file_format_version":"1.0.0","ICD":{"library_path":"/v/pkg/lib/libvulkan_intel.so","api_version":"1.1.102"}}\n' > /tmp/anv.json
export VK_ICD_FILENAMES=/tmp/anv.json
export LD_PRELOAD="/v/pkg/lib/vk_crumbs.so:$STUB" LD_LIBRARY_PATH=/v/pkg/lib
export VK_TRIAL_CRUMB_FD=9
exec 9>/o/crumbs.log

export WAYLAND_DISPLAY=wayland-1
mkdir -p /tmp/bin && printf '#!/bin/sh\nexit 0\n' > /tmp/bin/xrandr && chmod +x /tmp/bin/xrandr
export PATH=/tmp/bin:$PATH
export STEAM_COMPAT_DATA_PATH=/pfx STEAM_COMPAT_CLIENT_INSTALL_PATH=/tmp/steam
# DXVK, not WineD3D: Proton copies its dxvk folder's DLLs (1.10.3, mounted)
# into the prefix as native. New WoW64 as the Steam tool runs it (bundle.sh):
# without it a 32-bit program never starts ("Failed to create process": 731)
export PROTON_USE_WINED3D=0 PROTON_ENABLE_WAYLAND=1 PROTONFIXES_DISABLE=1 PROTON_ENABLE_NVAPI=0
export PROTON_USE_WOW64=1
export PROTON_LOG=1 PROTON_LOG_DIR=/tmp/log SteamGameId=0 SteamAppId=0
export WINEDEBUG=${WINEDEBUG:-err+all,fixme-all}
export DXVK_LOG_LEVEL=info DXVK_LOG_PATH='/tmp/log' T_LOG='Z:\tmp\log\t.log'

rc=0
for exe in "$@"; do
    name=$(basename "$exe" .exe)
    : > /tmp/log/t.log
    t0=$(date +%s)
    timeout "${T_TIMEOUT:-300}" "$PROTON/proton" run "$exe" >/tmp/log/proton.out 2>&1
    st=$?
    sed 's/^/   /' /tmp/log/t.log
    echo "== $name: exit $st$([ $st -eq 124 ] && echo ' (timed out)') in $(( $(date +%s) - t0 )) s"
    [ $st -ne 0 ] && [ $rc -eq 0 ] && rc=$st
    [ $st -eq 124 ] && { "$PROTON/files/bin/wineserver" -k 2>/dev/null; sleep 1; }
done
echo "== DXVK:"
cat /tmp/log/*_d3d11.log /tmp/log/*_dxgi.log 2>/dev/null | grep -E "info:  (DXVK|Vulkan|Built-in|Intel|Driver|Device|Feature|Skipping|Enabled device|  VK_)|err:|warn:" | sort | uniq -c | sort -rn | head -40
echo "== Wine's errors:"
grep -hE ":err:" /tmp/log/steam-*.log 2>/dev/null | sed -E 's/^([0-9.]+:)?([0-9a-f]+:)*err:/err:/' \
    | grep -vE "doesn't support (optional |xdg_toplevel_icon|xdg_activation|wp_fractional)" | sort | uniq -c | sort -rn | head -20
sleep 1.2
kill $SINK 2>/dev/null
echo "== wl-sink:"; grep -E '"ev":"(stats|toplevel|error)"' /tmp/log/wl-sink.log | tail -4
cp /tmp/log/* /o/ 2>/dev/null
exit $rc
