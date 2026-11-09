#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Inside a container of the unit's root filesystem (car_test.sh): vk-trial
# and the iris package where the car has them, a stand-in SSH session, then
# the car's steps: the gate armed for one `command` start, run.
# Mounts: /b vk-trial's build, /c this folder's build, /tst vk-trial's test/.
echo c0000000-0000-0000-0000-00000000000c > /tmp/bid && mount --bind /tmp/bid /proc/sys/kernel/random/boot_id
mkdir -p /var/opt/vk-trial && tar xzf /b/vk-trial.tgz -C /var/opt/vk-trial && tar xzf /c/iris-trial.tgz -C /var/opt/vk-trial && chmod 755 /var/opt/vk-trial
node /tst/fake_ssh.js & n=0; while [ ! -s /tmp/sshport ] && [ $n -lt 50 ]; do sleep 1; n=$((n + 1)); done
export SSH_CONNECTION="127.0.0.1 $(cat /tmp/sshport) 127.0.0.1 22"
G=/var/opt/vk-trial/bin/vk-trial
echo "== arm, run"
$G arm command --timeout 120 -- /bin/sh /var/opt/vk-trial/iris/run.sh && $G run; echo "run rc=$?"
d=$(cat /var/opt/vk-trial/state/last); echo "== out.log"; cat $d/out.log; echo "== result"; cat $d/result
echo "== crumbs: $(wc -l < $d/crumbs.log) lines, $(grep -c "> GEM_EXECBUFFER2" $d/crumbs.log) submissions"
echo "== left: run-dir:[$(ls -A /run/vk-trial)] procs:[$(ps | grep -c "[g]ltest\|[n]inetest")]"
