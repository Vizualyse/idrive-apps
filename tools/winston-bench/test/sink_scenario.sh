#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# In the bench's container (run.sh), with Winston up: one of our compositors
# between fake_client (Chromium's stand-in) and Winston, driven as its
# server.js drives it, on stdin. Pictures of the centre screen at each step:
#   /out/c-shown.ppm   after "winston X,Y,W,H"
#   /out/c-hidden.ppm  after "hide"
#   /out/c-again.ppm   after "winston" again (the picture kept while hidden)
# Logs: /out/sink.log (its JSON events), /out/fake.log.
#   sh /test/sink_scenario.sh chromium shm|drm WxH
SINK=$1 MODE=$2 SIZE=$3
D=/tmp/sink
mkdir -p $D
mkfifo $D/in
DRM=
[ "$MODE" = drm ] && DRM="--drm --unit-lib /usr/lib"
case $SINK in
    chromium) C=/sinks/chromium
              set -- $C/ld-linux-x86-64.so.2 --library-path $C $C/chromium-wl --dir $D --socket wayland-0 \
                     --size $SIZE --fps 30 --winston /run/wayland/wayland-0 $DRM ;;
    *) echo "unknown sink $SINK"; exit 2 ;;
esac
"$@" < $D/in > /out/sink.log 2>&1 &
exec 3>$D/in
sleep 0.5
/bench/fake_client $MODE $D/wayland-0 7 > /out/fake.log 2>&1 &
grab() { rm -f /out/grab.ppm; /bench/wo_bench grab && mv /out/grab.ppm /out/$1.ppm; }
sleep 1
echo "winston 108,82,1790,638" >&3
sleep 1.5; grab c-shown
echo hide >&3
sleep 1; grab c-hidden
echo "winston 108,82,1790,638" >&3
sleep 1; grab c-again
wait %2
exec 3>&-
sleep 0.3
