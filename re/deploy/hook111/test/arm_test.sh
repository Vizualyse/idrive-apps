#!/bin/sh
# arm_test.sh (re/run.sh deploy-test): hook111-arm.sh on the unit's own busybox
# (every tool it calls is the unit's busybox applet), with a fake systemctl
# driven by files, across boots, crashes, power loss and bad input.
#   arm_test.sh <rootfs> <hook111 dir>
set -u
RFS=$1; SRC=$2
T=$(mktemp -d /tmp/armtest.XXXXXX)
BB=$T/bb; mkdir -p "$BB"
for a in $("$RFS/bin/busybox.nosuid" --list); do ln -s "$RFS/bin/busybox.nosuid" "$BB/$a"; done
# the fake systemctl: show -p ... answers from $T/sys/<property>; hang mode sleeps
cat >"$BB/systemctl" <<'EOF'
#!/bin/sh
D=${FAKE_SYS:?}
[ -e "$D/hang" ] && sleep 30
if [ "$1" = is-system-running ]; then cat "$D/system" 2>/dev/null || echo running; exit 0; fi
[ "$1" = show ] || exit 1
shift 2
while [ $# -gt 0 ]; do
    [ "$1" = -p ] && { [ -r "$D/$2" ] && echo "$2=$(cat "$D/$2")" || echo "$2="; shift 2; continue; }
    shift
done
EOF
chmod +x "$BB/systemctl"
export PATH="$BB" FAKE_SYS="$T/sys"
export HOOK111_ROOT="$T/root" HOOK111_BOOT_ID_FILE="$T/boot_id" HOOK111_PROC="$T/proc" HOOK111_HEALTHY_AFTER=2 HOOK111_WATCH_FOR=4
S=$SRC/hook111-arm.sh
R=$T/root; V=$R/var/opt/hook111
mkdir -p "$R/usr/lib/cinemo" "$V/current" "$T/sys" "$T/proc"
cp "$RFS/usr/lib/cinemo/libNmeCarPlay.so" "$R/usr/lib/cinemo/"
echo stub >"$V/current/libhook111.so"
STOCK='MALLOC_ARENA_MAX=4 MALLOC_MMAP_THRESHOLD_=1048576 MALLOC_TRIM_THRESHOLD_=524288 LD_PRELOAD=/usr/lib/libschedconfig.so.1 WAYLAND_DISPLAY=wayland-1 XDG_RUNTIME_DIR=/run/wayland'
echo "$STOCK" >"$T/sys/Environment"
echo root >"$T/sys/User"   # carplay's user on the unit is cia_13002; root is one this container has
OURS=/var/opt/hook111/current/libhook111.so

fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; sed 's/^/       | /' "$T/out" 2>/dev/null; fail=1; fi; }
n=0
newboot() { n=$((n + 1)); echo "boot-$n" >"$T/boot_id"; rm -rf "$R/run"; }   # a reboot: new id, empty /run
freshboot() { sh "$S" reset >/dev/null; newboot; }   # a boot whose counting is not the subject
carplay() { echo "$1" >"$T/sys/ActiveState"; echo "$2" >"$T/sys/Result"; }
boot() { sh "$S" boot >"$T/out" 2>&1; rc=$?; }
armed() { [ -r "$R/run/hook111/env" ]; }
st() { grep "^$1=" "$V/state" | cut -d= -f2-; }

echo "== first start"
newboot; boot
check "exits 0" '[ $rc = 0 ]'
check "armed" 'armed'
check "env: the stock preload, then ours" "grep -qx 'LD_PRELOAD=\"/usr/lib/libschedconfig.so.1 $OURS\"' '$R/run/hook111/env'"
check "state: armed this start, no failures" '[ "$(st armed)" = boot-1 ] && [ "$(st fails)" = 0 ]'
check "the plist log directory, owned by carplay's user" '[ -d "$R/run/hook111/log" ] && [ "$(stat -c %U "$R/run/hook111/log")" = root ]'
sh "$S" boot >/dev/null 2>&1
check "a second run in the same start counts nothing" '[ "$(st fails)" = 0 ] && armed'

echo "== a crash at load, twice"
carplay failed core-dump; sh "$S" mark
check "mark: failed" "grep -qx 'boot-1 failed' '$V/shutdown'"
newboot; boot
check "1 failed start: armed again" 'armed && [ "$(st fails)" = 1 ]'
sh "$S" mark; newboot; boot
check "2 failed starts: not armed, carplay stock" '! armed && [ "$(st fails)" = 2 ] && grep -q "off after 2" "$T/out"'
newboot; boot
check "stays off" '! armed'
sh "$S" reset >/dev/null; newboot; boot
check "reset: armed again" 'armed && [ "$(st fails)" = 0 ]'

echo "== healthy, then a clean shutdown"
carplay active success; echo 4242 >"$T/sys/MainPID"; mkdir -p "$T/proc/4242"; echo "7f00-7f01 r-xp 0 0:0 0 $OURS" >"$T/proc/4242/maps"
t0=$(date +%s); sh "$S" health >"$T/out" 2>&1; t1=$(date +%s)
check "health: marked after carplay ran with the hook (${HOOK111_HEALTHY_AFTER} s)" '[ "$(st healthy)" = "$(cat $T/boot_id)" ] && [ $((t1 - t0)) -le 7 ]'
sh "$S" mark; newboot; boot
check "healthy + running at the mark: counter clear, armed" 'armed && [ "$(st fails)" = 0 ]'

echo "== crashes after it was healthy"
sh "$S" health >/dev/null 2>&1; carplay failed signal; sh "$S" mark; newboot; boot
check "healthy, then failed: counted" '[ "$(st fails)" = 1 ] && armed'
carplay active success; sh "$S" health >/dev/null 2>&1; carplay failed signal; sh "$S" mark; newboot; boot
check "again: off" '[ "$(st fails)" = 2 ] && ! armed'
sh "$S" reset >/dev/null; newboot; boot

echo "== power lost (no shutdown mark)"
carplay active success
newboot; boot
check "never healthy, no mark: counted" '[ "$(st fails)" = 1 ] && armed'
sh "$S" health >/dev/null 2>&1; newboot; boot
check "healthy, no mark: not counted" '[ "$(st fails)" = 1 ] && armed'
sh "$S" mark; newboot; boot
check "switched off before healthy (mark running): not counted" '[ "$(st fails)" = 1 ]'

echo "== health: the hook not in carplay"
echo "7f00-7f01 r-xp 0 0:0 0 /usr/lib/libc.so.6" >"$T/proc/4242/maps"
sh "$S" health >"$T/out" 2>&1
check "not loaded: never healthy" '[ "$(st healthy)" != "$(cat $T/boot_id)" ] && grep -q "watched" "$T/out"'
sh "$S" reset >/dev/null
echo "7f00-7f01 r-xp 0 0:0 0 $OURS" >"$T/proc/4242/maps"

echo "== the watcher: crashes it sees itself (no shutdown mark)"
export HOOK111_WATCH_FOR=12
crash_while_watched() {   # $1: seconds of a healthy run before carplay dies
    carplay active success; echo 4242 >"$T/sys/MainPID"; mkdir -p "$T/proc/4242"; echo "7f00-7f01 r-xp 0 0:0 0 $OURS" >"$T/proc/4242/maps"
    sh "$S" health >"$T/out" 2>&1 & w=$!
    sleep "$1"; carplay failed core-dump; echo 0 >"$T/sys/MainPID"; rm -rf "$T/proc/4242"
    t0=$(date +%s); wait $w; t1=$(date +%s)
}
freshboot; boot; sh "$S" reset >/dev/null   # counting starts here
crash_while_watched 4
check "a crash after healthy: recorded at once (<= 3 s), by the watcher" '[ "$(st crashed)" = "$(cat $T/boot_id)" ] && [ "$(st healthy)" = "$(cat $T/boot_id)" ] && [ $((t1 - t0)) -le 3 ]'
newboot; boot
check "the next start counts it, with no mark at all" '[ "$(st fails)" = 1 ] && grep -q "watcher saw carplay crash" "$T/out" && armed'
crash_while_watched 4; newboot; boot
check "two such starts: off" '[ "$(st fails)" = 2 ] && ! armed'
freshboot; boot
carplay failed core-dump; echo 0 >"$T/sys/MainPID"; rm -rf "$T/proc/4242"
sh "$S" health >"$T/out" 2>&1
check "carplay already failed when the watcher starts (a crash at load): recorded" '[ "$(st crashed)" = "$(cat $T/boot_id)" ]'
freshboot; boot
carplay active success; echo 4242 >"$T/sys/MainPID"; mkdir -p "$T/proc/4242"
sh "$S" health >"$T/out" 2>&1 & w=$!
sleep 3; echo stopping >"$T/sys/system"; carplay failed signal; echo 0 >"$T/sys/MainPID"; rm -rf "$T/proc/4242"; wait $w
check "carplay ending while the system stops: not a crash" '[ "$(st crashed)" != "$(cat $T/boot_id)" ] && grep -q "system stops" "$T/out"'
rm -f "$T/sys/system"
freshboot; boot
carplay active success; echo 4242 >"$T/sys/MainPID"; mkdir -p "$T/proc/4242" "$T/proc/4343"
sh "$S" health >"$T/out" 2>&1 & w=$!
sleep 3; echo 4343 >"$T/sys/MainPID"; rm -rf "$T/proc/4242"; wait $w
check "a run that ends cleanly and a new one starts: not a crash" '[ "$(st crashed)" != "$(cat $T/boot_id)" ]'
rm -rf "$T/proc/4343"; echo 4242 >"$T/sys/MainPID"; mkdir -p "$T/proc/4242"; echo "7f00-7f01 r-xp 0 0:0 0 $OURS" >"$T/proc/4242/maps"
export HOOK111_WATCH_FOR=4
sh "$S" reset >/dev/null

echo "== refusals"
newboot; cp "$R/usr/lib/cinemo/libNmeCarPlay.so" "$T/lib.bak"; echo x >>"$R/usr/lib/cinemo/libNmeCarPlay.so"; boot
check "another libNmeCarPlay.so build: not armed" '! armed && grep -q "not the build" "$T/out"'
cp "$T/lib.bak" "$R/usr/lib/cinemo/libNmeCarPlay.so"
newboot; mv "$V/current/libhook111.so" "$T/l.bak"; boot
check "preload missing: not armed" '! armed && grep -q missing "$T/out"'
mv "$T/l.bak" "$V/current/libhook111.so"
sh "$S" disable >/dev/null; newboot; boot
check "disabled: not armed" '! armed && grep -q disabled "$T/out"'
sh "$S" enable >/dev/null; newboot; boot
check "enabled: armed" 'armed'

echo "== carplay.service's environment"
sh "$S" reset >/dev/null   # each boot below has no mark and no health check: counting is not the subject here
echo 'X=1 "LD_PRELOAD=/a.so /b.so" Y=2' >"$T/sys/Environment"; freshboot; boot
check "quoted LD_PRELOAD kept whole" "grep -qx 'LD_PRELOAD=\"/a.so /b.so $OURS\"' '$R/run/hook111/env'"
echo 'X=1 Y=2' >"$T/sys/Environment"; freshboot; boot
check "no stock LD_PRELOAD: ours alone" "grep -qx 'LD_PRELOAD=\"$OURS\"' '$R/run/hook111/env'"
echo "$STOCK" >"$T/sys/Environment"
touch "$T/sys/hang"; freshboot; t0=$(date +%s); boot; t1=$(date +%s)
check "systemctl hangs: bounded (<= 7 s), not armed" '! armed && [ $((t1 - t0)) -le 7 ] && grep -q unreadable "$T/out"'
t0=$(date +%s); sh "$S" mark; t1=$(date +%s)
check "mark with systemctl hanging: <= 5 s, exits 0, writes nothing new" '[ $((t1 - t0)) -le 5 ] && ! grep -q "$(cat $T/boot_id)" "$V/shutdown"'
rm -f "$T/sys/hang"

echo "== config and state input"
sh "$S" reset >/dev/null
printf 'HOOK111_SINK_PORT=7001\nHOOK111_SINK_PORT=1; rm -rf /\nOTHER=1\nHOOK111_DATA_PORT=6031\n' >"$V/config"; newboot; boot
check "config: only HOOK111_*=<number> passes" "grep -qx 'HOOK111_SINK_PORT=7001' '$R/run/hook111/env' && grep -qx 'HOOK111_DATA_PORT=6031' '$R/run/hook111/env' && [ \$(wc -l <'$R/run/hook111/env') = 3 ]"
rm -f "$V/config"
sed -i 's/^fails=.*/fails=abc/' "$V/state"; newboot; boot
check "unreadable counter: stays off" '! armed'
sh "$S" reset >/dev/null
printf '#!/bin/sh\nexit 1\n' >"$T/sync"; chmod +x "$T/sync"; mv "$BB/sync" "$T/sync.bb"; cp "$T/sync" "$BB/sync"
newboot; boot
check "state cannot be saved: not armed (an arm nobody counts would never turn off)" '! armed && [ $rc = 0 ]'
rm -f "$BB/sync"; mv "$T/sync.bb" "$BB/sync"

echo "== every command exits 0"
for c in status disable enable reset bogus; do sh "$S" $c >/dev/null 2>&1; check "$c: exit 0" "[ $? = 0 ]"; done

rm -rf "$T"
[ $fail = 0 ] && echo PASS || echo FAIL
exit $fail
