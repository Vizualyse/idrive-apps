#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# The tool end to end in a container made from the head unit's own root
# filesystem (../idrive-rootfs/20.40.2/rootfs.tar, imported once as
# idrive-rootfs:I_21w12.2-1-4, as vizualyse-chromium's tests), with no
# network, on the GPU bench's stand-in for the unit's GPU (test/unit_test.js
# says what it covers).
#   sh native/vizualyse-steam/test/run_unit_test.sh [stub|swrast]   (both by default)
# VERBOSE=1 shows the tool's log as it goes.
# Builds what's missing: the bundles (build.sh), the test programs
# (test/build_win.sh), the GPU bench (tools/gpu-bench/build.sh).
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")/.." && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
GPU_BENCH=$HERE/../../tools/gpu-bench
IMG=idrive-rootfs:I_21w12.2-1-4
ROOTFS=${ROOTFS:-$HERE/../../../idrive-rootfs/20.40.2/rootfs.tar}
docker image inspect $IMG >/dev/null 2>&1 || docker import "$ROOTFS" $IMG >/dev/null
sh "$HERE/build.sh" >&2
sh "$HERE/test/build_win.sh" >&2
sh "$GPU_BENCH/build.sh" >&2
WIN_GPU_BENCH=$(cd "$GPU_BENCH/build" && (pwd -W 2>/dev/null || pwd))
# The controller check (as vizualyse-moonlight's): a virtual XInput USB pad
# (test/usbip_pad.c, the platform's) through the Docker host's vhci_hcd, so
# steam-pads finds a real usbfs device; skipped where the kernel has none.
# NO_USBIP=1 skips it.
PADOPT=
if [ "${NO_USBIP:-}" != 1 ] && docker run --rm -v "$WIN_HERE:/m" $(sh "$HERE/build.sh" image-name) \
        gcc -O2 -Wall -Wextra -Werror -static -o /m/build/test-usbip-pad /m/test/usbip_pad.c; then
    # vhci_hcd is a module in Docker Desktop's (WSL 2) kernel: load it in the host's namespaces
    docker run --rm --privileged --pid=host alpine nsenter -t 1 -m -- modprobe vhci-hcd >/dev/null 2>&1 || true
    if docker run --rm --privileged alpine test -w /sys/devices/platform/vhci_hcd.0/attach; then
        PADOPT="--privileged -v /dev/bus/usb:/dev/bus/usb -e STEAM_TEST_USBPAD=/t/build/test-usbip-pad"
    else
        echo "no vhci_hcd in the Docker host's kernel: the controller check is skipped" >&2
    fi
fi
run() {
    NAME=steam-unit-test-$$
    trap 'docker rm -f $NAME >/dev/null 2>&1' EXIT INT TERM
    # SYS_ADMIN: the tool's mounts of a USB stick; a tmpfs at /media/TESTSTICK
    # stands in for one the HMI mounted (read-only, noexec, files 0777 as FAT).
    # USB_FS=vfat: a real FAT32 image (build/vfat.img, mkfs.vfat -F 32) on a
    # loop device instead, with the HMI's own options (needs --privileged)
    if [ "${USB_FS:-tmpfs}" = vfat ]; then
        CAPS=--privileged
        # the loop device read-write (as the car's sdb1), only the mount read-only
        STICK="cp /t/build/vfat.img /tmp/vfat.img && L=\$(losetup -f) && losetup \$L /tmp/vfat.img && mount -t vfat -o ro,nosuid,nodev,noexec,uid=2010,gid=2010,fmask=0000,dmask=0000,allow_utime=0022,shortname=mixed,showexec,utf8,flush \$L /media/TESTSTICK"
    else
        CAPS="--cap-add SYS_ADMIN"
        STICK="mount -t tmpfs -o ro,nosuid,nodev,noexec,mode=0777,size=256m teststick /media/TESTSTICK"
    fi
    # Vulkan (the bundled vulkan.tgz): tools/vk-trial's build at /vkt for
    # kernel414, the unit's kernel's answers on the stub (build.sh makes it)
    VKT=
    [ -f "$HERE/../../tools/vk-trial/build/bench/kernel414.so" ] && VKT="-v $(cd "$HERE/../../tools/vk-trial/build" && (pwd -W 2>/dev/null || pwd)):/vkt:ro"
    # the tools' bus: native/vizualyse-bus's broker, when built (the Browser's asks)
    BUSOPT=
    [ -f "$HERE/../vizualyse-bus/build/mosquitto" ] && BUSOPT="-v $(cd "$HERE/../vizualyse-bus" && (pwd -W 2>/dev/null || pwd)):/bus:ro -e MOSQUITTO=/var/opt/mosquitto -e MOSQUITTO_CONF=/bus/src/mosquitto.conf"
    # shellcheck disable=SC2086 # VKT and BUSOPT are word lists
    docker run --rm --name $NAME --platform linux/amd64 --network none --shm-size=1g $CAPS $PADOPT $VKT $BUSOPT \
        -v "$WIN_HERE:/t:ro" -v "$WIN_GPU_BENCH:/g:ro" -e GPU="$1" -e USB_FS="${USB_FS:-tmpfs}" ${T_GAME:+-e T_GAME="$T_GAME"} ${T_NOSTEAM:+-e T_NOSTEAM=1} ${T_LOAD:+-e T_LOAD="$T_LOAD"} ${T_DLLOV:+-e T_DLLOV="$T_DLLOV"} ${VERBOSE:+-e VERBOSE=1} ${GREP_LOG:+-e GREP_LOG="$GREP_LOG"} ${STEAM_WINEDEBUG:+-e STEAM_WINEDEBUG="$STEAM_WINEDEBUG"} $IMG \
        /bin/sh -c "mkdir -p /var/opt /tmp /run /media/TESTSTICK && chmod 1777 /tmp && { [ ! -f /bus/build/mosquitto ] || { cp /bus/build/mosquitto /var/opt/mosquitto && chmod 0755 /var/opt/mosquitto; }; } && $STICK && ulimit -c 0 && ulimit -n 524288 2>/dev/null; /usr/bin/node /t/test/unit_test.js /t"
}
case "${1:-all}" in
    stub|swrast) run "$1" ;;
    all) run stub && run swrast ;;
    *) echo "usage: run_unit_test.sh [stub|swrast]" >&2; exit 2 ;;
esac
