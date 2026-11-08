#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# The gate's own test, in the unit's root filesystem (idrive-rootfs, BusyBox,
# glibc 2.27), no network. Each "boot" is a container: a fresh tmpfs /run
# (as the unit's), its own boot id (bound over /proc's, hence SYS_ADMIN),
# and one Docker volume as /var/opt/vk-trial that outlives it, as the
# unit's flash does. bin/vkprobe is a fake here (test/fake_probe.sh) that
# reports what the child sees; the real driver is test/anv_test.sh's.
#   sh tools/vk-trial/test/gate_test.sh
set -eu
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")/.." && pwd)
WIN_HERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
ROOTFS_IMG=idrive-rootfs:I_21w12.2-1-4
sh "$HERE/build.sh" >&2
IMG=$(cat "$HERE/build/image")
VOL=vk-trial-gate-test-$$
fails=0
ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1"; fails=$((fails + 1)); }
has() { if printf '%s\n' "$1" | grep -qF -- "$2"; then ok "$3"; else bad "$3 (no \"$2\")"; printf '%s\n' "$1" | sed 's/^/       | /'; fi; }
hasnt() { if printf '%s\n' "$1" | grep -qF -- "$2"; then bad "$3 (\"$2\")"; printf '%s\n' "$1" | sed 's/^/       | /'; else ok "$3"; fi; }
cleanup() { docker rm -f vk-trial-hang-$$ >/dev/null 2>&1 || true; docker volume rm -f "$VOL" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# SSH as on the unit: a listener on 22 and this shell's session to it
# (test/fake_ssh.js), SSH_CONNECTION as sshd sets it
SSHUP='node /tst/fake_ssh.js & n=0; while [ ! -s /tmp/sshport ] && [ $n -lt 50 ]; do sleep 1; n=$((n + 1)); done;
    export SSH_CONNECTION="127.0.0.1 $(cat /tmp/sshport) 127.0.0.1 22"'
# boot ID SCRIPT [docker options...]: one boot of the unit, SCRIPT in BusyBox sh, run over "SSH"
boot() {
    id=$1 script=$2
    shift 2
    boot_bare "$id" "$SSHUP; $script" "$@"
}
# the same without any SSH
boot_bare() {
    id=$1 script=$2
    shift 2
    docker run --rm --network none --cap-add SYS_ADMIN --tmpfs /tmp --tmpfs /run:mode=755 \
        -v "$VOL:/var/opt/vk-trial" -v "$WIN_HERE/build:/b:ro" -v "$WIN_HERE/test:/tst:ro" "$@" $ROOTFS_IMG \
        sh -c "echo $id > /tmp/bid && mount --bind /tmp/bid /proc/sys/kernel/random/boot_id && $script" 2>&1 || true
}
G=/var/opt/vk-trial/bin/vk-trial
LASTOUT='cat $(cat /var/opt/vk-trial/state/last)/out.log'

docker volume create "$VOL" >/dev/null
boot 00000000-0000-0000-0000-00000000000a "tar xzf /b/vk-trial.tgz -C /var/opt/vk-trial && chmod 755 /var/opt/vk-trial \
    && cp /tst/fake_probe.sh /var/opt/vk-trial/bin/vkprobe && chmod 755 /var/opt/vk-trial/bin/vkprobe" >/dev/null

echo "== unarmed"
out=$(boot b1 "$G run; echo rc=\$?; ls /run/vk-trial 2>&1; ls /var/opt/vk-trial/state/log 2>&1")
has "$out" "not armed: nothing done" "run without arming does nothing"
has "$out" "rc=3" "and says so in its exit code"
hasnt "$out" "icd.json" "no ICD file appears"
has "$out" "No such file or directory" "no state, no log folder made"

echo "== armed: one start"
out=$(boot b2 "$G arm instance; $G status; $G run; echo rc=\$?; $LASTOUT; echo \"run-dir:[\$(ls /run/vk-trial)]\"; $G run; echo rc2=\$?; $G status")
has "$out" "armed for one start: stage instance" "arm"
has "$out" "armed: stage instance (one start)" "status shows the arming"
has "$out" "disarmed; trying stage instance" "run"
has "$out" "rc=0" "the probe's success"
has "$out" "probe: arm gone" "the arming is gone before the child starts"
hasnt "$out" "CONSUMED LEFT" "nothing of it left"
has "$out" "probe: uid=12990 gid=44 groups=44" "the child: uid 12990, group video only"
has "$out" "probe: state closed" "the child can't write the gate's state"
has "$out" "probe: icd=/run/vk-trial/icd.json {\"file_format_version\":\"1.0.0\",\"ICD\":{\"library_path\":\"/var/opt/vk-trial/lib/libvulkan_intel.so\"" "the ICD in /run, for the child only"
has "$out" "probe: preload=/var/opt/vk-trial/lib/vk_crumbs.so" "breadcrumbs preloaded"
has "$out" "probe: stage=instance" "the armed stage"
has "$out" "probe: core Max core file size 1 1 bytes" "RLIMIT_CORE=1 in the child (no core for the crash handler)"
has "$out" "probe: crumb fd ok" "the crumb fd"
has "$out" "run-dir:[]" "the ICD removed after: /run/vk-trial empty"
has "$out" "rc2=3" "a second run in the same boot does nothing"
has "$out" "armed: no" "status: not armed after"
has "$out" "last: ok" "the result kept"

echo "== SSH before anything: a way in that doesn't need the screen"
out=$(boot_bare s1 "$G arm instance; echo rc=\$?; $G status")
has "$out" "nothing listens on TCP port 22: no SSH to get back in. Not armed" "no SSH listening: arm refuses"
has "$out" "rc=4" "exit code 4"
has "$out" "ssh: NOT READY (arming refused)" "status says so"
out=$(boot_bare s2 "node /tst/fake_ssh.js & sleep 2; $G arm instance; echo rc=\$?")
has "$out" "port 22 is open (node (pid" "port 22 open, its owner named"
has "$out" "not started from an SSH session (no SSH_CONNECTION)" "but not from an SSH session: arm refuses"
out=$(boot_bare s3 "node /tst/fake_ssh.js & sleep 2; SSH_CONNECTION='127.0.0.1 1 127.0.0.1 22' $G arm instance; echo rc=\$?")
has "$out" "the SSH connection from 127.0.0.1:1 to port 22 is not established" "a session that isn't connected: arm refuses"
out=$(boot s4 "$G arm instance; echo rc=\$?")
has "$out" "ssh: port 22 open (node (pid" "over SSH: the check passes"
has "$out" "this session from 127.0.0.1:" "with the session named"
has "$out" "armed for one start" "and it arms"
# armed over SSH, then SSH gone before the run: the run is used up, nothing loads
out=$(boot s5 "$G arm instance >/dev/null && kill \$(pidof node) && sleep 1 && $G run; echo rc=\$?; $G status; echo \"run-dir:[\$(ls /run/vk-trial)]\"; ls /var/opt/vk-trial/state")
has "$out" "nothing listens on TCP port 22: no SSH to get back in: disarmed, nothing done" "SSH gone at the run: disarmed, nothing done"
has "$out" "rc=3" "exit code 3"
has "$out" "armed: no" "not armed any more"
has "$out" "run-dir:[]" "no ICD written"
has "$out" "trial: none going on" "no marker written"
out=$(boot s6 "$G arm instance >/dev/null && $G run; echo rc=\$?; cat \$(cat /var/opt/vk-trial/state/last)/gate.log")
has "$out" "ssh: port 22 open (node" "the run's gate.log records the SSH check"

echo "== a restart forgets the arming"
boot b3 "$G arm compute" >/dev/null
out=$(boot b4 "$G status; $G run; echo rc=\$?")
has "$out" "armed: no" "after a restart: not armed"
has "$out" "rc=3" "run does nothing"

echo "== arming refused"
out=$(docker run --rm --network none --tmpfs /tmp -v "$VOL:/var/opt/vk-trial" -v "$WIN_HERE/test:/tst:ro" $ROOTFS_IMG \
    sh -c "$SSHUP; $G arm instance; echo rc=\$?" 2>&1 || true)
has "$out" "not on tmpfs" "with /run not on tmpfs"
out=$(boot b5 "mkdir -p /usr/share/vulkan/icd.d && echo {} > /usr/share/vulkan/icd.d/intel_icd.json && $G arm instance; echo rc=\$?; $G status")
has "$out" "/usr/share/vulkan/icd.d/intel_icd.json" "names a system-wide ICD"
has "$out" "not armed: remove or rename them first" "and refuses while one is there"
has "$out" "armed: no" "not armed"
out=$(boot b5 "$G arm compute --timeout 2; $G arm command; $G arm bogus; $G arm instance -- /bin/true; $G status")
has "$out" "--timeout between 5 and 600" "a timeout out of range"
has "$out" "arm command -- PROGRAM" "command without a program"
has "$out" "unknown stage 'bogus'" "an unknown stage"
has "$out" "a program only with the stage 'command'" "a program with a probe stage"
has "$out" "armed: no" "none of them armed"

echo "== an arming from another boot is refused"
out=$(boot b6 "mkdir -p /run/vk-trial && printf 'stage=instance\ntimeout=30\nboot=someotherboot\n' > /run/vk-trial/armed && $G run; echo rc=\$?; echo \"run-dir:[\$(ls /run/vk-trial)]\"")
has "$out" "from another boot" "refused"
has "$out" "run-dir:[]" "and used up all the same: /run/vk-trial empty"

echo "== two runs at once: one start"
out=$(boot b7 "$G arm command -- /bin/sleep 2 >/dev/null; ($G run > /tmp/r1 2>&1 &); ($G run > /tmp/r2 2>&1 &); sleep 4; cat /tmp/r1 /tmp/r2")
n=$(printf '%s\n' "$out" | grep -c "disarmed; trying" || true)
[ "$n" = 1 ] && ok "exactly one of two runs started" || { bad "two runs: $n started"; printf '%s\n' "$out" | sed 's/^/       | /'; }
has "$out" "not armed: nothing done" "the other did nothing"

echo "== the display node is refused"
out=$(boot b8 "$G arm command -- /bin/cat /dev/dri/card0 >/dev/null; $G run; $LASTOUT; cat \$(cat /var/opt/vk-trial/state/last)/crumbs.log")
has "$out" "Permission denied" "cat /dev/dri/card0 in the child fails"
has "$out" "! refused open /dev/dri/card0" "and the crumbs say why"

echo "== timeout"
out=$(boot b9 "$G arm command --timeout 5 -- /bin/sleep 100 >/dev/null; $G run; echo rc=\$?; $G status; cat \$(cat /var/opt/vk-trial/state/last)/result; ls /var/opt/vk-trial/state")
has "$out" "5 s are up: killing" "killed after its timeout"
has "$out" "sysrq w:" "tried to dump blocked tasks (read-only /proc here)"
has "$out" "result=timeout" "result: timeout"
has "$out" "rc=6" "exit code 6"
has "$out" "trial: none going on" "the marker removed (the child died)"

echo "== a child that stops making progress (no crumb for 8 s)"
out=$(boot b10 "$G arm command --timeout 15 -- /bin/sleep 30 >/dev/null; $G run; echo rc=\$?; d=\$(cat /var/opt/vk-trial/state/last); cat \$d/result \$d/gate.log")
has "$out" "no progress for 8 s" "noticed before the timeout"
case "$out" in *"no progress for 8 s"*"sysrq w:"*"15 s are up"*) ok "blocked tasks asked for at the stall, then killed at 15 s" ;;
    *) bad "stall order"; printf '%s\n' "$out" | sed 's/^/       | /' ;; esac
c=$(printf '%s\n' "$out" | grep -c "^vk-trial: sysrq w:" || true)
[ "$c" = 1 ] && ok "asked once, not again at the timeout" || bad "sysrq asked $c times"
has "$out" "result=timeout" "result: timeout"
# gate.log's lines start with the time (epoch seconds)
t=$(printf '%s\n' "$out" | grep '^[0-9].*no progress for 8 s' | cut -d. -f1); s=$(printf '%s\n' "$out" | grep '^[0-9].*started /bin/sleep' | cut -d. -f1)
[ -n "$t" ] && [ -n "$s" ] && [ $((t - s)) -ge 7 ] && [ $((t - s)) -le 10 ] && ok "after 8 s ($((t - s)) s in gate.log)" || bad "stall timing: started $s, stall $t"

echo "== the kernel log (a /dev/kmsg of the Docker VM; fake i915 lines written into it)"
KMSG="--device /dev/kmsg --cap-add SYSLOG"
out=$(boot b11 "echo 'vk-trial-test: before the try, must not be copied' > /dev/kmsg; \
    $G arm command -- /bin/sleep 4 >/dev/null; \
    (sleep 2; echo 'i915 0000:00:02.0: [drm] GPU HANG: ecode 9:0:0x85dffffb, in vkprobe [99], reason: hang on rcs0 (vk-trial-test)' > /dev/kmsg; \
     echo 'INFO: task HmiMain3D:123 blocked for more than 10 seconds. (vk-trial-test)' > /dev/kmsg) & \
    $G run; echo rc=\$?; d=\$(cat /var/opt/vk-trial/state/last); echo '-- kmsg.log'; cat \$d/kmsg.log; echo '-- result'; cat \$d/result" $KMSG)
has "$out" "GPU HANG: ecode 9:0:0x85dffffb" "the kernel's lines copied into kmsg.log"
hasnt "$out" "before the try, must not be copied" "only from the start of the try"
has "$out" "result=gpu-hang" "a GPU hang in the kernel log is the result, though the child exited 0"
has "$out" "kernel_gpu_hang=yes" "kernel_gpu_hang=yes"
has "$out" "kernel_blocked_tasks=yes" "kernel_blocked_tasks=yes"
has "$out" "the kernel reported a GPU hang, the kernel reported blocked tasks" "and says so"
has "$out" "rc=6" "exit code 6"
out=$(boot b12 "$G arm instance; echo rc0=\$?" $KMSG)
has "$out" "hung the unit or the GPU" "after a GPU hang, arm wants --again"
has "$out" "rc0=4" "exit code 4"
out=$(boot b12 "$G arm command --again -- /bin/true >/dev/null; $G run; echo rc=\$?; cat \$(cat /var/opt/vk-trial/state/last)/result" $KMSG)
has "$out" "result=ok" "a clean try with the kernel log on: ok"
has "$out" "kernel_gpu_hang=no" "no hang reported"

echo "== the display nodes: hidden from the child by its own mount namespace, not from the system"
# / made shared first, as on the car (mountinfo: "/ ... shared:1"): Docker's
# own is private, where a namespace bind could never leak and the check
# below would prove nothing
NODES='mount --make-rshared / && mkdir -p /dev/dri/by-path && mknod /dev/dri/card0 c 226 0 && mknod /dev/dri/renderD128 c 226 128 \
    && ln -s ../card0 /dev/dri/by-path/pci-0000:00:02.0-card && cp /tst/show_nodes.sh /var/opt/vk-trial/bin/ && chmod 755 /var/opt/vk-trial/bin/show_nodes.sh'
out=$(boot b13 "$NODES && $G arm command -- /var/opt/vk-trial/bin/show_nodes.sh >/dev/null; \
    (sleep 1; echo \"system card0 during: \$(stat -c %t,%T /dev/dri/card0)\"; grep -c card0 /proc/self/mountinfo | sed 's/^/system card0 mounts: /') & \
    $G run; echo rc=\$?; $LASTOUT; echo \"system card0 after: \$(stat -c %t,%T /dev/dri/card0)\"")
has "$out" "display nodes hidden: 1" "the gate hid one display node"
has "$out" "child card0 abs: 1,3" "the child gets /dev/null for /dev/dri/card0"
has "$out" "child card0 rel: 1,3" "by a relative path too"
has "$out" "child card0 link: 1,3" "and through the by-path symlink"
has "$out" "child render: e2,80" "the render node stays"
has "$out" "system card0 during: e2,0" "the system still sees card0 during the try"
has "$out" "system card0 mounts: 0" "no mount of it in the system's namespace"
has "$out" "system card0 after: e2,0" "nor after"
has "$out" "rc=0" "the try: ok"

echo "== a child that can't make its namespace never starts"
out=$(docker run --rm --network none --tmpfs /tmp --tmpfs /run:mode=755 -v "$VOL:/var/opt/vk-trial" -v "$WIN_HERE/test:/tst:ro" $ROOTFS_IMG \
    sh -c "$SSHUP; $G arm instance >/dev/null; $G run; echo rc=\$?; d=\$(cat /var/opt/vk-trial/state/last); cat \$d/out.log \$d/result" 2>&1 || true)
has "$out" "vk-trial child: unshare: Operation not permitted: not started" "no SYS_ADMIN here: unshare refused"
has "$out" "the child failed before starting" "the gate says so"
hasnt "$out" "probe:" "the probe never ran"
has "$out" "how=exit 110" "exit 110"
has "$out" "result=failed" "result: failed"

echo "== the gate dies mid-try, same boot"
out=$(boot b14 "$G arm command -- /bin/sleep 1000 >/dev/null; ($G run >/dev/null 2>&1 &); sleep 2; \
    kill -9 \$(pidof vk-trial); sleep 0.5; echo \"child: \$(pidof sleep)\"; \
    $G arm instance; echo rc=\$?; $G status; kill -9 \$(pidof sleep); sleep 0.5; \
    $G arm instance; echo rc2=\$?; $G status; echo \"run-dir:[\$(ls /run/vk-trial)]\"")
has "$out" "still runs without its gate: probably stuck in the kernel. Restart the unit" "child alive without its gate: arm refuses"
has "$out" "rc=4" "exit code 4"
has "$out" "closed as died" "child gone too: the try closed as died"
has "$out" "rc2=0" "and arming works again"
has "$out" "last: died" "status: last: died"
has "$out" "run-dir:[armed]" "the killed gate's ICD removed when the try is closed (only the new arming left)"
out=$(boot b15 "$G arm command -- /bin/sleep 1000 >/dev/null; ($G run >/dev/null 2>&1 &); sleep 2; \
    kill -9 \$(pidof vk-trial) \$(pidof sleep); sleep 0.5; $G status")
has "$out" "closed as died" "gate and child killed together: closed at the next start"
has "$out" "trial: none going on" "nothing left going on"

echo "== the unit restarts mid-try (power cut while the child runs)"
docker run -d --name vk-trial-hang-$$ --network none --cap-add SYS_ADMIN --tmpfs /tmp --tmpfs /run:mode=755 \
    -v "$VOL:/var/opt/vk-trial" -v "$WIN_HERE/test:/tst:ro" $ROOTFS_IMG sh -c "echo c1 > /tmp/bid && mount --bind /tmp/bid /proc/sys/kernel/random/boot_id \
    && $SSHUP; $G arm command --timeout 600 -- /bin/sleep 1000 && $G run" >/dev/null
sleep 3
maps=$(docker exec vk-trial-hang-$$ sh -c 'for p in $(pidof vk-trial); do cat /proc/$p/maps; done')
if [ -n "$maps" ] && ! printf '%s\n' "$maps" | grep -q '\.so'; then ok "the gate has no library mapped (static)"
else bad "the gate's maps: $(printf '%s\n' "$maps" | grep '\.so' | head -3)"; fi
docker kill vk-trial-hang-$$ >/dev/null; docker rm -f vk-trial-hang-$$ >/dev/null
out=$(boot c2 "$G status; $G arm instance; echo rc=\$?; $G arm instance --again; echo rc2=\$?; $G status")
has "$out" "never ended: the unit restarted during it" "the next boot says the try hung"
has "$out" "the last try hung the unit" "arm refuses after a hang"
has "$out" "rc=4" "exit code 4"
has "$out" "armed for one start" "--again arms"
has "$out" "last: hung" "the result: hung"

echo "== the disarm is the first thing run does (strace, in the build image)"
# Before main(), static glibc 2.27's own start: brk, arch_prctl, uname,
# readlink(/proc/self/exe), access(/etc/ld.so.nohwcap). It loads nothing;
# the first call of ours must be the rename.
tr=$(docker run --rm --network none -v "$WIN_HERE/build:/b:ro" "$IMG" sh -c '
    mkdir -p /run/vk-trial; strace -o /tmp/t /b/pkg/bin/vk-trial run >/dev/null 2>&1; echo "== unarmed"; cat /tmp/t
    printf "stage=instance\ntimeout=30\nboot=x\n" > /run/vk-trial/armed; strace -o /tmp/t /b/pkg/bin/vk-trial run >/dev/null 2>&1; echo "== armed"; cat /tmp/t' 2>&1)
first=$(printf '%s\n' "$tr" | sed -n '/== armed/,$p' | grep -vE '^==|execve|brk\(|arch_prctl|uname|readlink\("/proc/self/exe"|set_tid_address|set_robust_list|rt_sigaction|rt_sigprocmask|prlimit64|mprotect|access\("/etc/ld.so.nohwcap"' | head -1)
case "$first" in *'rename("/run/vk-trial/armed", "/run/vk-trial/consumed")'*) ok "first syscall: $first" ;;
    *) bad "first syscall: $first"; printf '%s\n' "$tr" | sed 's/^/       | /' ;; esac
unarmed=$(printf '%s\n' "$tr" | sed -n '/== unarmed/,/== armed/p' | grep -vE '^==|execve|brk\(|arch_prctl|uname|readlink\("/proc/self/exe"|set_tid_address|set_robust_list|prlimit64|mprotect|access\("/etc/ld.so.nohwcap"|exit_group|^\+\+\+' )
case "$unarmed" in *rename*ENOENT*write\(1*) [ "$(printf '%s\n' "$unarmed" | wc -l)" -le 2 ] && ok "unarmed: rename fails, one message, nothing else" \
    || { bad "unarmed did more"; printf '%s\n' "$unarmed" | sed 's/^/       | /'; } ;;
    *) bad "unarmed trace"; printf '%s\n' "$unarmed" | sed 's/^/       | /' ;; esac

[ $fails -eq 0 ] || { echo "vk-trial gate: $fails failed" >&2; exit 1; }
echo "vk-trial gate: all passed"
