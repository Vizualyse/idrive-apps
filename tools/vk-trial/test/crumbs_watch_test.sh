#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# vk_crumbs.so's watch mode (VK_TRIAL_CRUMB_MODE=watch: the Steam tool's
# games), off the car: a program making a game's DRM calls (test/crumbs_watch.c)
# against a stand-in kernel that keeps one call for 2.5 s (test/slowdrm.c).
# Checks: a process's first lines are written as they happen, the frames
# after them are not written at all (and cost next to nothing, on a log
# opened O_DSYNC as the tool opens it), the kept call is written with the
# lines before it while it is still away, and again when it is back, in a
# forked child too; and without the mode every call is written, as ever
# (the gate's trials: it takes a growing log as its sign of life).
#   sh tools/vk-trial/test/crumbs_watch_test.sh
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")/.." && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
# its own small image (a compiler, libdrm's headers, the unit's glibc): vk_crumbs.so as build.sh builds it
IMG=idrive-crumbs-test:$(sha256sum < "$HERE/test/crumbs/Dockerfile" | cut -c1-8)
docker image inspect "$IMG" >/dev/null 2>&1 || docker build -q -t "$IMG" "$WIN_HERE/test/crumbs" >/dev/null
# the log on the container's own disk (ext4), opened O_DSYNC by a helper: the shell can't
out=$(docker run --rm --network none -v "$WIN_HERE:/m:ro" "$IMG" sh -ec '
    W="-O2 -std=gnu11 -Wall -Wextra -Werror"
    mkdir -p /tmp/b/pkg/lib /tmp/b/bench
    gcc $W -shared -fPIC -o /tmp/b/pkg/lib/vk_crumbs.so /m/src/vk_crumbs.c -ldl -lpthread
    gcc $W -shared -fPIC -o /tmp/b/bench/slowdrm.so /m/test/slowdrm.c -ldl
    gcc $W -o /tmp/b/bench/crumbs_watch /m/test/crumbs_watch.c
    cat > /tmp/dsync.c <<EOF
#include <fcntl.h>
#include <stdlib.h>
#include <unistd.h>
int main(int c, char **v) { (void)c; int fd = open(v[1], O_WRONLY | O_CREAT | O_TRUNC | O_DSYNC, 0600); if (fd < 0 || dup2(fd, 9) < 0) return 2; execvp(v[2], v + 2); return 3; }
EOF
    gcc -O2 -o /tmp/dsync /tmp/dsync.c
    B=/tmp/b
    run() { VK_TRIAL_CRUMB_FD=9 LD_PRELOAD=$B/pkg/lib/vk_crumbs.so:$B/bench/slowdrm.so /tmp/dsync "$1" $B/bench/crumbs_watch "$2"; }
    # exported, not set before the function: dash keeps such a variable from the programs a function starts
    export VK_TRIAL_CRUMB_MODE=watch
    echo "== watch"; run /tmp/watch.log 20000; echo "rc=$?"
    unset VK_TRIAL_CRUMB_MODE
    echo "lines=$(wc -l < /tmp/watch.log)"
    grep -n -E "crumbs: |! " /tmp/watch.log | sed "s/^/  | /"
    # the report and what stands just before it
    n=$(grep -n -m1 "! not back after" /tmp/watch.log | cut -d: -f1)
    [ -z "$n" ] || echo "before the report: $(sed -n "$((n - 3)),$((n - 1))p" /tmp/watch.log | grep -c -E "> GEM_EXECBUFFER2|< GEM_WAIT|> GEM_WAIT")"
    echo "== as ever"; run /tmp/sync.log 400; echo "rc=$?"
    echo "synclines=$(wc -l < /tmp/sync.log)"
    echo "syncreports=$(grep -c "! " /tmp/sync.log || true)"' 2>&1 || true)
printf '%s\n' "$out" | sed 's/^/  | /'
fails=0
ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1"; fails=$((fails + 1)); }
has() { if printf '%s\n' "$out" | grep -qE -- "$1"; then ok "$2"; else bad "$2"; fi; }
num() { printf '%s\n' "$out" | sed -n "s/^$1=\([0-9]*\).*/\1/p" | head -1; }
has "crumbs: pid [0-9]+ \(watch\)" "the mode is said at the process's start"
has "from here a call is written only when it is not back in 1000 ms" "after its first lines the process says it only watches"
l=$(num lines)
if [ "${l:-0}" -ge 400 ] && [ "${l:-0}" -le 520 ]; then ok "40000 calls left $l lines: the first 400 and the reports"; else bad "40000 calls left ${l:-?} lines (400 to 520 wanted)"; fi
ms=$(printf '%s\n' "$out" | sed -n 's/^20000 frames (40000 calls) in \([0-9]*\) ms.*/\1/p' | head -1)
# the first 200 calls are written as they happen (O_DSYNC: a few ms each on a slow disk); the other 39800 must not be
if [ -n "$ms" ] && [ "$ms" -lt 6000 ]; then ok "20000 frames in $ms ms on an O_DSYNC log"; else bad "20000 frames took ${ms:-?} ms"; fi
has "! not back after 1[0-9][0-9][0-9] ms: > GEM_WAIT fd [0-9]+ handle 77" "the kept call is written a second after it went, while still away"
has "before the report: 3" "with the calls before it"
has "! back after 2[0-9][0-9][0-9] ms: GEM_WAIT" "and again when it is back"
n=$(printf '%s\n' "$out" | grep -c "! not back after" || true)
if [ "$n" -eq 2 ]; then ok "the forked child's kept call too"; else bad "$n kept calls reported, 2 wanted (the parent's and the child's)"; fi
has "parent: the kept call came back after 2[0-9][0-9][0-9] ms" "the call itself is not held up"
s=$(num synclines)
if [ "${s:-0}" -ge 1600 ]; then ok "without the mode every call is written ($s lines for 800 calls)"; else bad "without the mode: ${s:-?} lines"; fi
has "syncreports=0" "and nothing is watched"
[ "$(printf '%s\n' "$out" | grep -c 'rc=0')" -eq 2 ] && ok "both runs ended well" || bad "a run failed"
[ $fails -eq 0 ] || { echo "vk-trial crumbs watch: $fails failed" >&2; exit 1; }
echo "vk-trial crumbs watch: all passed"
