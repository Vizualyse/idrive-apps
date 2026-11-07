#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# The car's DXVK try, off the car: the unit's own root filesystem, the Steam
# tool's real bundles unpacked where the car has them (runtime, Proton, its
# prefix, launch.json), vk-trial's two packages in /var/opt/vk-trial, its
# gate armed by hand for one `command` start over a (stand-in) SSH session,
# gpu-bench's stub GPU behind kernel414. Exactly the steps README.md lists
# for the car: run.js setup as root, then arm, run.
#   sh tools/vk-trial/dxvk/car_test.sh
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")" && pwd)
VKT=$(cd "$HERE/.." && pwd)
STEAM=$(cd "$VKT/../../native/vizualyse-steam" && pwd)
win() { (cd "$1" && (pwd -W 2>/dev/null || pwd)); }
sh "$HERE/package.sh" >&2
[ -f "$STEAM/build/prefix.tgz" ] || { echo "car test: no Steam bundles (sh native/vizualyse-steam/build.sh)" >&2; exit 2; }
NAME=vk-trial-dxvk-car-$$
trap 'docker rm -f $NAME >/dev/null 2>&1' EXIT INT TERM
out=$(docker run --rm --name $NAME --network none --shm-size=1g --cap-add SYS_ADMIN --tmpfs /run:mode=755 --tmpfs /tmp:exec,mode=1777 \
    -v "$(win "$VKT/build"):/b:ro" -v "$(win "$VKT/../gpu-bench/build"):/g:ro" -v "$(win "$STEAM/build"):/sb:ro" -v "$(win "$VKT/test"):/tst:ro" \
    -e VK_TRIAL_EXTRA_PRELOAD=/b/bench/kernel414.so:/g/stub/libintel_noop_drm_shim.so -e INTEL_STUB_GPU_PLATFORM=bxt \
    idrive-rootfs:I_21w12.2-1-4 sh -c '
    echo c0000000-0000-0000-0000-00000000000c > /tmp/bid && mount --bind /tmp/bid /proc/sys/kernel/random/boot_id
    mkdir -p /var/opt && cd / && for t in runtime proton prefix; do tar xzf /sb/$t.tgz; done
    cp /sb/launch.json /var/opt/vizualyse-steam/launch.json
    chown -R -h 12996:12996 /var/opt/vizualyse-steam/prefix
    mkdir -p /var/opt/vizualyse-steam/gpu-libs && for l in libEGL.so.1 libgbm.so.1 libglapi.so.0 libGLESv2.so.2; do ln -sf /usr/lib/$l /var/opt/vizualyse-steam/gpu-libs/$l; done
    mkdir -p /var/opt/vk-trial && tar xzf /b/vk-trial.tgz -C /var/opt/vk-trial && tar xzf /b/vk-trial-dxvk.tgz -C /var/opt/vk-trial && chmod 755 /var/opt/vk-trial
    node /tst/fake_ssh.js & n=0; while [ ! -s /tmp/sshport ] && [ $n -lt 50 ]; do sleep 1; n=$((n + 1)); done
    export SSH_CONNECTION="127.0.0.1 $(cat /tmp/sshport) 127.0.0.1 22"
    echo "== setup (root)"; node /var/opt/vk-trial/dxvk/run.js setup; echo "setup rc=$?"
    # nothing outside vk-trial may change owner (the prefix links to /, /dev/ttyS*, Proton)
    echo "owner of / $(stat -c %u /), ttyS0 $(stat -c %u /dev/ttyS0 2>/dev/null || echo none), 12990 outside vk-trial: [$(find / -xdev -user 12990 2>/dev/null | grep -v "^/var/opt/vk-trial/" | wc -l)] in /dev: [$(find /dev -user 12990 2>/dev/null | wc -l)]"
    G=/var/opt/vk-trial/bin/vk-trial
    echo "== arm, run"; $G arm command --timeout 300 -- /usr/bin/node /var/opt/vk-trial/dxvk/run.js run && $G run; echo "run rc=$?"
    d=$(cat /var/opt/vk-trial/state/last); echo "== out.log"; cat $d/out.log; echo "== result"; cat $d/result
    echo "== crumbs: $(wc -l < $d/crumbs.log) lines, $(grep -c "> GEM_EXECBUFFER2" $d/crumbs.log) submissions"; grep "run.js:" $d/crumbs.log
    echo "== left: run-dir:[$(ls -A /run/vk-trial)] procs:[$(ps | grep -c "[w]ine\|[w]l-sink")]"' 2>&1 || true)
printf '%s\n' "$out"
fails=0
for want in "setup rc=0" "prefix ready" "owner of / 0," "12990 outside vk-trial: [0] in /dev: [0]" "run rc=0" "result=ok" "t_d3d11: device, feature level 11_1" "t_d3d1164.exe: ok" \
        "t_d3d9: device" "t_d3d964.exe: ok" "GPU (wl_drm)" "dxvk: ok" "run-dir:[]"; do
    printf '%s\n' "$out" | grep -qF -- "$want" && echo "  ok   $want" || { echo "  FAIL $want"; fails=$((fails + 1)); }
done
[ $fails -eq 0 ] || { echo "vk-trial dxvk car test: $fails failed" >&2; exit 1; }
echo "vk-trial dxvk car test: all passed"
