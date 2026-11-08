#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Mesa 19.0.6's ANV (or MESA_VER's) through the real gate and probe, in the unit's root
# filesystem, on gpu-bench's stub GPU (the no-op shim faking the unit's HD
# 505) behind test/kernel414.c (the unit's IOTG 4.14 kernel's answers).
# Every stage, as each try on the car would be armed, then the ioctls ANV
# asks compared with the unit's own i965 (gpu-bench's gltest), which runs on
# the car every day.
#   sh tools/vk-trial/test/anv_test.sh          (OUT=dir keeps the logs)
# What it can't show: the kernel (no i915 here) and the GPU running anything.
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")/.." && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
WIN_BENCH=$(cd "$HERE/../gpu-bench" && (pwd -W 2>/dev/null || pwd))
ROOTFS_IMG=idrive-rootfs:I_21w12.2-1-4
sh "$HERE/build.sh" >&2
# which ANV build.sh made (MESA_VER), and the Vulkan version it reports
MESA=$(cat "$HERE/build/mesa")
# (Mesa 22+ names the chip "APL 3", probes syncobjs without a timed-out wait,
# and speaks linux-dmabuf to wl-sink: vkprobe gives it --dmabuf by lib/mesa)
CHIP=Broxton; SYNCOBJ_ETIME=1
case $MESA in 19.0.6) VK_API=1.1.96 ;; 19.1.8) VK_API=1.1.102 ;; 19.3.5) VK_API=1.1.102 ;;
    22.3.7) VK_API=1.3.230; CHIP="APL 3"; SYNCOBJ_ETIME= ;; 23.1.9) VK_API=1.3.246; CHIP="APL 3"; SYNCOBJ_ETIME= ;;
    *) echo "anv_test: no Vulkan version known for Mesa $MESA" >&2; exit 2 ;; esac
VK_API=${VK_API_OVERRIDE:-$VK_API}
OUT=${OUT:-$HERE/build/anv-test}
mkdir -p "$OUT"
WIN_OUT=$(cd "$OUT" && (pwd -W 2>/dev/null || pwd))
fails=0
ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1"; fails=$((fails + 1)); }
has() { if grep -qF -- "$2" "$1" 2>/dev/null; then ok "$3"; else bad "$3 (no \"$2\" in $(basename "$1"))"; fi; }
hasnt() { [ -f "$1" ] || { bad "$3 (no $(basename "$1"))"; return; }; if grep -qF -- "$2" "$1"; then bad "$3 (\"$2\" in $(basename "$1"))"; grep -F -- "$2" "$1" | head -3 | sed 's/^/       | /'; else ok "$3"; fi; }

# one boot: install, then each stage armed and run once; logs copied out
docker run --rm --network none --cap-add SYS_ADMIN --tmpfs /tmp --tmpfs /run:mode=755 --tmpfs /var/opt:exec \
    -v "$WIN_HERE/build:/b:ro" -v "$WIN_BENCH/build:/bench:ro" -v "$WIN_OUT:/o" -v "$WIN_HERE/test:/tst:ro" \
    -e VK_TRIAL_EXTRA_PRELOAD=/b/bench/kernel414.so:/bench/stub/libintel_noop_drm_shim.so \
    -e INTEL_STUB_GPU_PLATFORM=bxt $ROOTFS_IMG sh -c '
    echo b0000000-0000-0000-0000-00000000000b > /tmp/bid && mount --bind /tmp/bid /proc/sys/kernel/random/boot_id
    # SSH as on the unit (test/fake_ssh.js): the gate wants a live session
    node /tst/fake_ssh.js & n=0; while [ ! -s /tmp/sshport ] && [ $n -lt 50 ]; do sleep 1; n=$((n + 1)); done
    export SSH_CONNECTION="127.0.0.1 $(cat /tmp/sshport) 127.0.0.1 22"
    mkdir -p /var/opt/vk-trial && tar xzf /b/vk-trial.tgz -C /var/opt/vk-trial && chmod 755 /var/opt/vk-trial
    G=/var/opt/vk-trial/bin/vk-trial
    for s in instance enumerate device compute draw present; do
        $G arm $s >/dev/null && $G run > /o/$s.gate 2>&1; echo "rc=$?" >> /o/$s.gate
        d=$(cat /var/opt/vk-trial/state/last)
        for f in out.log crumbs.log result; do cp $d/$f /o/$s.$f; done
    done
    # the unit s i965 through the same crumbs (no gate: it is not a trial)
    VK_TRIAL_CRUMB_FD=3 LD_PRELOAD=/var/opt/vk-trial/lib/vk_crumbs.so:/b/bench/kernel414.so:/bench/stub/libintel_noop_drm_shim.so \
        /bench/gltest --desktop-gl > /o/i965.out.log 2>&1 3>/o/i965.crumbs.log; echo "rc=$?" >> /o/i965.out.log
    true' 2>&1 | sed 's/^/  | /'

for s in instance enumerate device compute draw present; do
    echo "== stage $s"
    has "$OUT/$s.gate" "rc=0" "the gate: ok"
    has "$OUT/$s.result" "result=ok" "result: ok"
    has "$OUT/$s.out.log" "stage $s: ok" "the probe reached $s"
    hasnt "$OUT/$s.out.log" "DRM_SHIM: unhandled" "every ioctl answered"
    hasnt "$OUT/$s.out.log" "kernel414: HAZARD" "no ioctl that means something else on the unit's kernel"
    hasnt "$OUT/$s.crumbs.log" "! refused" "the display node never asked for"
    case $s in
    instance) hasnt "$OUT/$s.crumbs.log" "open /dev/dri" "no device opened yet" ;;
    enumerate) has "$OUT/$s.out.log" "device: Intel(R) HD Graphics 505 ($CHIP), Vulkan $VK_API, driver $MESA, 8086:5a84" "ANV on the unit's chip, Vulkan $VK_API"
               [ -z "$SYNCOBJ_ETIME" ] || has "$OUT/$s.crumbs.log" "< SYNCOBJ_WAIT = -1 Timer expired" "a fresh syncobj's wait: ETIME, as the car answered"
               has "$OUT/$s.crumbs.log" "< GETPARAM = 0 param 30 -> 1" "MMAP_VERSION 1, as the car answered"
               has "$OUT/$s.out.log" "driver $MESA, 8086:5a84" "Mesa $MESA, the car's PCI id"
               has "$OUT/$s.crumbs.log" "< GETPARAM = -1 Invalid argument param 50" "asked for context isolation, told no (as 4.14)"
               hasnt "$OUT/$s.crumbs.log" "GEM_EXECBUFFER2" "nothing submitted" ;;
    device) hasnt "$OUT/$s.out.log" "stage compute" "stopped after device" ;;
    compute) has "$OUT/$s.crumbs.log" "> GEM_EXECBUFFER2" "the dispatch submitted"
             has "$OUT/$s.out.log" "compute: not run (the bench's stub GPU" "the stub ran nothing (expected here)"
             hasnt "$OUT/$s.out.log" "stage draw" "stopped after compute" ;;
    draw) has "$OUT/$s.out.log" "stage compute: ok" "compute first"
          has "$OUT/$s.crumbs.log" "probe: compiling the draw shaders" "the graphics pipeline compiled"
          has "$OUT/$s.crumbs.log" "probe: submitting the draw" "the draw submitted"
          has "$OUT/$s.out.log" "65536 untouched" "the stub ran nothing: every pixel as before (expected here)"
          has "$OUT/$s.out.log" "draw: not run (the bench's stub GPU" "accepted on the bench only"
          hasnt "$OUT/$s.out.log" "stage present" "stopped after draw" ;;
    present) has "$OUT/$s.out.log" "\"ev\":\"ready\"" "wl-sink started (the unit's EGL on the stub)"
             has "$OUT/$s.out.log" "\"drm\":true" "wl-sink offers wl_drm (the render node through the unit's i965)"
             has "$OUT/$s.out.log" "surface + wayland_surface enabled" "the window-system extensions, at this stage only"
             has "$OUT/$s.out.log" "present: 60 frames presented" "60 FIFO frames presented"
             has "$OUT/$s.out.log" "and 0 shared-memory buffers" "no frame by shared memory"
             if grep -q "pictures from [1-9][0-9]* GPU (wl_drm)" "$OUT/$s.out.log"; then ok "wl-sink took GPU (wl_drm PRIME) buffers"
             else bad "wl-sink took no wl_drm buffer"; fi
             has "$OUT/$s.out.log" "GPU buffers reached wl-sink, the picture black" "black on the stub (expected here)"
             if grep -q "^[0-9.]* \[[0-9]*\] > GEM_EXECBUFFER2" "$OUT/$s.crumbs.log" && [ "$(grep -o '^[0-9.]* \[[0-9]*\]' "$OUT/$s.crumbs.log" | awk '{print $2}' | sort -u | wc -l)" -ge 2 ]; then
                 ok "the crumbs hold both the probe's and wl-sink's calls"
             else bad "the crumbs don't show two processes"; fi ;;
    esac
done
echo "== the unit's i965 (gltest) through the same crumbs"
has "$OUT/i965.out.log" "result: ok" "gltest ran"

# what ANV asks the kernel that i965 never does on the car
calls() { grep -o '> [A-Z_0-9]*\( fd [0-9]*\)\?\( param [0-9]*\| ctx [0-9]* param 0x[0-9a-f]*\)\?' "$1" | sed 's/ fd [0-9]*//; s/ ctx [0-9]*//' | sort -u; }
calls "$OUT/draw.crumbs.log" > "$OUT/anv.calls"
calls "$OUT/i965.crumbs.log" > "$OUT/i965.calls"
comm -23 "$OUT/anv.calls" "$OUT/i965.calls" > "$OUT/anv-only.calls"
grep -h '< GETPARAM' "$OUT/draw.crumbs.log" | sed 's/^[0-9.]* \[[0-9]*\] //' | sort -u > "$OUT/anv.params"
grep -h '< GETPARAM' "$OUT/i965.crumbs.log" | sed 's/^[0-9.]* \[[0-9]*\] //' | sort -u > "$OUT/i965.params"
grep -h 'EXECBUFFER2' "$OUT/draw.crumbs.log" | grep -o 'flags 0x[0-9a-f]*' | sort | uniq -c > "$OUT/anv.execflags"
grep -h 'EXECBUFFER2' "$OUT/i965.crumbs.log" | grep -o 'flags 0x[0-9a-f]*' | sort | uniq -c > "$OUT/i965.execflags"
echo "== ioctls ANV asks that the unit's i965 doesn't ($OUT/anv-only.calls)"
sed 's/^/  /' "$OUT/anv-only.calls"
echo "== GETPARAM answers ANV got (kernel414 + stub)"
sed 's/^/  /' "$OUT/anv.params"
echo "== execbuffer2 flags: ANV / i965"
sed 's/^/  anv  /' "$OUT/anv.execflags"; sed 's/^/  i965 /' "$OUT/i965.execflags"
echo "== ANV's submissions (draw: every stage)"
grep '> GEM_EXECBUFFER2\|CONTEXT_[GS]ETPARAM\|> GEM_WAIT' "$OUT/draw.crumbs.log" | sed 's/^[0-9.]* \[[0-9]*\] /  /' | sort | uniq -c
echo "== i965's submissions (gltest)"
grep '> GEM_EXECBUFFER2\|CONTEXT_[GS]ETPARAM' "$OUT/i965.crumbs.log" | sed 's/^[0-9.]* \[[0-9]*\] /  /; s/ batch_len [0-9]*//' | sort | uniq -c | head -12

[ $fails -eq 0 ] || { echo "vk-trial anv: $fails failed (logs: $OUT)" >&2; exit 1; }
echo "vk-trial anv: all passed (logs: $OUT)"
