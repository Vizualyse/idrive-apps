#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
# gate_test.sh's stand-in for bin/vkprobe: says what the child sees.
echo "probe: uid=$(id -u) gid=$(id -g) groups=$(id -G)"
if [ -e /run/vk-trial/armed ]; then echo "probe: ARMED STILL"; else echo "probe: arm gone"; fi
[ -e /run/vk-trial/consumed ] && echo "probe: CONSUMED LEFT"
echo "probe: icd=$VK_ICD_FILENAMES $(cat "$VK_ICD_FILENAMES")"
echo "probe: preload=$LD_PRELOAD"
echo "probe: stage=$1"
echo "probe: core $(grep 'core file' /proc/self/limits | tr -s ' ')"
echo "fake probe" >&3 && echo "probe: crumb fd ok"
if touch /var/opt/vk-trial/state/x 2>/dev/null; then echo "probe: STATE WRITABLE"; else echo "probe: state closed"; fi
exit 0
