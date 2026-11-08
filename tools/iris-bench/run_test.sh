#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Mesa 19.3.5's iris (tools/iris-bench/build.sh) on tools/gpu-bench's stub:
# the unit's HD 505 faked by Mesa's no-op shim, behind kernel414.so (the
# unit's IOTG 4.14 answers: no context isolation, no I915_QUERY). Checks:
#   - gltest through iris's own EGL set: GLES 3.2, desktop GL 4.6
#   - no ioctl that means something else on the unit's kernel (kernel414's HAZARD)
#   - the registers iris writes (INTEL_DEBUG=bat): without isolation no
#     CS_DEBUG_MODE2 and no CS_CHICKEN1 (i965 and ANV 19.0.6 write neither
#     there); with it (the shim alone, a newer kernel) stock iris writes both
#   - the unit's own libEGL 19.0.6 can't load iris 19.3.5 (a crash: a
#     different GL dispatch), so iris needs its own set
#   - Gallium Nine's d3dadapter9 makes an adapter on the render node
#   sh tools/iris-bench/run_test.sh
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")" && pwd)
sh "$HERE/build.sh" >&2
GB=$HERE/../gpu-bench
SHIM=/bench/stub/libintel_noop_drm_shim.so
U414="LD_PRELOAD=/t/bench/kernel414.so:$SHIM"
IRIS="INTEL_STUB_GPU_PLATFORM=bxt MESA_LOADER_DRIVER_OVERRIDE=iris LIBGL_DRIVERS_PATH=/t/lib/dri"
out=$(MOUNT="$HERE/build" timeout 300 sh "$GB/run.sh" stub sh -c "
    echo '== gltest'; $U414 $IRIS LD_LIBRARY_PATH=/t/lib /bench/gltest --desktop-gl 2>&1
    echo '== registers, unit kernel'; $U414 $IRIS LD_LIBRARY_PATH=/t/lib INTEL_DEBUG=bat /bench/gltest 2>&1 | grep -o '^register [A-Za-z0-9_]*' | sort -u
    echo '== registers, newer kernel'; LD_PRELOAD=$SHIM $IRIS LD_LIBRARY_PATH=/t/lib INTEL_DEBUG=bat /bench/gltest 2>&1 | grep -o '^register [A-Za-z0-9_]*' | sort -u
    echo '== the unit libEGL'; $U414 $IRIS /bench/gltest >/dev/null 2>&1; echo \"unit-egl rc=\$?\"
    echo '== nine'; $U414 $IRIS LD_LIBRARY_PATH=/t/lib /t/bench/ninetest /t/lib/d3d/d3dadapter9.so.1 2>&1
    echo '== end'" 2>&1)
printf '%s\n' "$out" | sed 's/^/  | /'
fails=0
sect() { printf '%s\n' "$out" | awk -v s="== $1" '$0 == s {on=1; next} /^== / {on=0} on'; }
want() { if printf '%s\n' "$2" | grep -qE -- "$3"; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails + 1)); fi; }
hasnt() { if printf '%s\n' "$2" | grep -qE -- "$3"; then echo "  FAIL $1"; fails=$((fails + 1)); else echo "  ok   $1"; fi; }
want "iris: GLES 3.2" "$(sect gltest)" "gl_version: OpenGL ES 3.2 Mesa 19.3.5"
want "iris: desktop GL 4.6 core" "$(sect gltest)" "desktop_gl_core: 4.6"
want "the patch engaged on the unit's kernel" "$(sect gltest)" "iris: no context isolation in the kernel"
want "gltest ok" "$(sect gltest)" "^result: ok"
hasnt "no ioctl that means something else on the unit's kernel" "$out" "HAZARD"
hasnt "unit kernel: no CS_DEBUG_MODE2 write" "$(sect 'registers, unit kernel')" "CS_DEBUG_MODE2"
hasnt "unit kernel: no CS_CHICKEN1 write" "$(sect 'registers, unit kernel')" "CS_CHICKEN1"
want "newer kernel: stock iris writes CS_DEBUG_MODE2" "$(sect 'registers, newer kernel')" "CS_DEBUG_MODE2"
hasnt "the unit's libEGL 19.0.6 can't run iris 19.3.5 (expected: its own set)" "$(sect 'the unit libEGL')" "rc=0"
want "Gallium Nine: an adapter on the render node, VS/PS 3.0" "$(sect nine)" "PASS: Nine's adapter"
[ $fails -eq 0 ] && echo "iris-bench: all passed" || { echo "iris-bench: $fails failed"; exit 1; }
