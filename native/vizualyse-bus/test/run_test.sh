#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# The bus off the car, as root on Node 8 with no network:
#  - the platform's client (tool/mqtt_bus, its newest version) against
#    Mosquitto as built for the unit (build.sh) with its shipped
#    mosquitto.conf: asks, retained, cleared, a killed tool's last will, the
#    broker restarting, other users kept out;
#  - Cast pausing its cluster video while another tool asks (its bus_test.js).
# In a container made from the head unit's root filesystem
# (../idrive-rootfs/20.40.2/rootfs.tar, imported once as
# idrive-rootfs:I_21w12.2-1-4), or BUS_TEST_IMAGE (CI: Ubuntu 18.04 with
# Node 8, native/vizualyse-moonlight/test/unit).
#   sh native/vizualyse-bus/test/run_test.sh       VERBOSE=1: the logs too
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(cd "$HERE/../.." && pwd)
WIN_REPO=$(cd "$REPO" && (pwd -W 2>/dev/null || pwd))
IMG=${BUS_TEST_IMAGE:-idrive-rootfs:I_21w12.2-1-4}
if [ -z "${BUS_TEST_IMAGE:-}" ]; then
    ROOTFS=${ROOTFS:-$REPO/../idrive-rootfs/20.40.2/rootfs.tar}
    docker image inspect $IMG >/dev/null 2>&1 || docker import "$ROOTFS" $IMG >/dev/null
fi
sh "$HERE/build.sh" >&2
# Cast's platform copies (its mqtt_bus.js); a Windows path for a Windows node
(cd "$REPO" && node platform/platform.js sync native/vizualyse-cast >/dev/null)
MOD=platform/tool/mqtt_bus/$(cd "$REPO/platform/tool/mqtt_bus" && ls -d */ | tr -d / | sort -V | tail -1)
docker run --rm --network none -v "$WIN_REPO:/r:ro" \
    -e MOSQUITTO=/tmp/mosquitto -e MOSQUITTO_CONF=/r/native/vizualyse-bus/src/mosquitto.conf ${VERBOSE:+-e VERBOSE=1} \
    $IMG /bin/sh -c 'mkdir -p /run /tmp && cp /r/native/vizualyse-bus/build/mosquitto /tmp/mosquitto && chmod 0755 /tmp/mosquitto &&
        /tmp/mosquitto -h 2>&1 | head -1; echo "node $(node --version)";
        echo "== the client ('"$MOD"')" && node /r/'"$MOD"'/test/mqtt_bus_test.js &&
        echo "== Cast" && node /r/native/vizualyse-cast/test/bus_test.js'
