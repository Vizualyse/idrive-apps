#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Inside a container of the unit's root filesystem (car_test.sh): lays out
# the car (the Steam tool's bundles where it has them, vk-trial's packages,
# a stand-in SSH session), then the car's steps: run.js setup as root, the
# gate armed for one `command` start, run.
#   car_steps.sh offscreen|winston
# winston: armed with --winston, run.js run winston (Winston must be up: the
# winston bench starts the unit's own before this).
# Mounts: /b vk-trial's build, /g gpu-bench's, /sb the Steam tool's, /tst
# vk-trial's test/.
MODE=${1:-offscreen}
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
echo "owner of / $(stat -c %u /), 12990 outside vk-trial: [$(find / -xdev -user 12990 2>/dev/null | grep -v "^/var/opt/vk-trial/" | wc -l)] in /dev: [$(find /dev -user 12990 2>/dev/null | wc -l)]"
G=/var/opt/vk-trial/bin/vk-trial
if [ "$MODE" = winston ]; then ARM="--winston"; RUN="run winston"; else ARM=; RUN=run; fi
# DXVK_PROGRAMS (car_test.sh, commas): run.js's arguments, as typed on the car
RUN="$RUN $(echo "${DXVK_PROGRAMS:-}" | tr ',' ' ')"
echo "== arm, run ($MODE)"
# shellcheck disable=SC2086
$G arm command --timeout 300 $ARM -- /usr/bin/node /var/opt/vk-trial/dxvk/run.js $RUN && $G run; echo "run rc=$?"
d=$(cat /var/opt/vk-trial/state/last); echo "== out.log"; cat $d/out.log; echo "== result"; cat $d/result
echo "== crumbs: $(wc -l < $d/crumbs.log) lines, $(grep -c "> GEM_EXECBUFFER2" $d/crumbs.log) submissions"; grep "run.js:" $d/crumbs.log
echo "== left: run-dir:[$(ls -A /run/vk-trial)] procs:[$(ps | grep -c "[w]ine\|[w]l-sink")]"
