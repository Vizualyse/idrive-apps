#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# iris on the car, through tools/vk-trial's gate (never by hand, never from
# systemd): the child the gate starts, as uid 12990 in group video, the
# display nodes hidden (offscreen only: GBM on the render node). The gate
# passes no environment, so everything is set here.
#   vk-trial arm command --timeout 120 -- /bin/sh /var/opt/vk-trial/iris/run.sh
# Steps, each printed as "== name" then its lines:
#   iris       gltest on iris (its own EGL set): GLES 3, the drawn pixels
#              checked, desktop GL tried
#   registers  the registers iris writes (INTEL_DEBUG=bat): on the unit's
#              kernel (no context isolation) no CS_DEBUG_MODE2, no CS_CHICKEN1
#   nine       Gallium Nine's adapter on the render node (ninetest)
#   i965 after the unit's own Mesa (i965, as the HMI) still draws right
# On the bench (gpu-bench's stub behind kernel414, preloaded by the gate)
# nothing is really drawn: the pixel checks are left out there.
D=$(cd "$(dirname "$0")" && pwd)
case "${LD_PRELOAD:-}" in *noop_drm_shim*) STUB=1; export INTEL_STUB_GPU_PLATFORM=bxt ;; *) STUB= ;; esac
PIX=--pixels; [ -n "$STUB" ] && PIX=
IRIS="LD_LIBRARY_PATH=$D/lib LIBGL_DRIVERS_PATH=$D/lib/dri MESA_LOADER_DRIVER_OVERRIDE=iris"
echo "== iris"
env $IRIS "$D/bin/gltest" $PIX --desktop-gl 2>&1; echo "iris rc=$?"
echo "== registers"
env $IRIS INTEL_DEBUG=bat "$D/bin/gltest" 2>&1 | grep -o '^register [A-Za-z0-9_]*' | sort -u
echo "== nine"
env $IRIS "$D/bin/ninetest" "$D/lib/d3d/d3dadapter9.so.1" 2>&1; echo "nine rc=$?"
echo "== i965 after"
"$D/bin/gltest" $PIX 2>&1; echo "i965 rc=$?"
echo "== end"
