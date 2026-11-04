#!/bin/sh
# hook111-arm.sh: decide, once per head-unit start, whether carplay starts with
# the stream-111 hook (libhook111.so) preloaded. busybox ash (the unit's /bin/sh).
#
#   boot     hook111-arm.service, Before=carplay.service: count the last armed
#            start's outcome, then write /run/hook111/env (or not)
#   mark     var-opt-ro.service drop-in, before /var/opt goes read-only at a
#            shutdown or crash reboot: record how carplay is doing
#   health   hook111-health.service: a carplay that has run 60 s with the hook
#            loaded marks this start healthy
#   status | disable | enable | reset
#
# Nothing on / changes. The env file is on /run (tmpfs): every reboot, a crash
# reboot included, starts stock unless this step arms it again. carplay's
# drop-in only reads it (EnvironmentFile=-/run/hook111/env). This script never
# stops, kills or restarts anything, and always exits 0.
#
# Counting: the last armed start counts as failed when carplay had failed at
# its shutdown mark, or when it has no mark and never got healthy (power lost,
# a crash before the mark could run). It counts as good (the counter is
# cleared) when it got healthy and carplay was running or stopped at the mark.
# At THRESHOLD failed starts in a row the hook stays off until `reset`.

ROOT=${HOOK111_ROOT:-}
VAR=$ROOT/var/opt/hook111
RUN=$ROOT/run/hook111
STATE=$VAR/state
SHUTDOWN=$VAR/shutdown
PRELOAD=${HOOK111_PRELOAD:-/var/opt/hook111/current/libhook111.so}   # as carplay sees it
LIB=$ROOT/usr/lib/cinemo/libNmeCarPlay.so
LIB_SHA256=8838c272f5e46715740e36e985e761b1d85a0b399376d0de2348c38309051fa5
BOOT_ID_FILE=${HOOK111_BOOT_ID_FILE:-/proc/sys/kernel/random/boot_id}
PROC=${HOOK111_PROC:-/proc}
SYSTEMCTL=${HOOK111_SYSTEMCTL:-systemctl}
THRESHOLD=2
HEALTHY_AFTER=${HOOK111_HEALTHY_AFTER:-60}     # seconds
HEALTH_GIVE_UP=${HOOK111_HEALTH_GIVE_UP:-900}  # seconds

log() { echo "hook111-arm: $*"; }

# run "$@" for at most $1 seconds (busybox has no timeout); its stdout on ours
bounded() {
    _n=$1; shift
    _t=$(mktemp "${TMPDIR:-/tmp}/hook111.XXXXXX") || return 1
    "$@" >"$_t" 2>/dev/null &
    _p=$!; _i=0
    while kill -0 "$_p" 2>/dev/null; do
        if [ "$_i" -ge $((_n * 10)) ]; then kill -9 "$_p" 2>/dev/null; wait "$_p" 2>/dev/null; rm -f "$_t"; return 124; fi
        sleep 0.1; _i=$((_i + 1))
    done
    wait "$_p"; _rc=$?
    cat "$_t"; rm -f "$_t"
    return $_rc
}

# state: fails=N armed=<boot id or empty> healthy=<boot id or empty> last=<text>
fails=0 armed= healthy= last=
load_state() {
    [ -f "$STATE" ] || return 0
    while IFS='=' read -r k v; do
        case $k in
        fails) case $v in ''|*[!0-9]*) fails=$THRESHOLD ;; *) fails=$v ;; esac ;;   # unreadable: stay off
        armed) armed=$v ;; healthy) healthy=$v ;; last) last=$v ;;
        esac
    done <"$STATE"
}
save_state() {   # whole, or not at all: temp file, sync, rename
    mkdir -p "$VAR" 2>/dev/null
    _t="$STATE.tmp.$$"
    { echo "fails=$fails"; echo "armed=$armed"; echo "healthy=$healthy"; echo "last=$last"; } >"$_t" 2>/dev/null \
        && sync && mv -f "$_t" "$STATE" && sync && return 0
    rm -f "$_t"; return 1
}

boot_id() { cat "$BOOT_ID_FILE" 2>/dev/null; }

# carplay.service's own LD_PRELOAD (Environment=, without our EnvironmentFile)
stock_preload() {
    _env=$(bounded 5 "$SYSTEMCTL" show carplay.service -p Environment) || return 1
    case $_env in Environment=*) ;; *) return 1 ;; esac
    # tokens are space-separated; one with spaces in its value is quoted whole: "LD_PRELOAD=a b"
    echo "${_env#Environment=}" | awk '{
        s = $0; out = ""; found = 0
        while (length(s) > 0) {
            sub(/^ +/, "", s); if (s == "") break
            if (substr(s, 1, 1) == "\"") { s = substr(s, 2); i = index(s, "\""); if (!i) i = length(s) + 1; t = substr(s, 1, i - 1); s = substr(s, i + 1) }
            else { i = index(s, " "); if (!i) i = length(s) + 1; t = substr(s, 1, i - 1); s = substr(s, i + 1) }
            if (substr(t, 1, 11) == "LD_PRELOAD=") { out = substr(t, 12); found = 1 }
        }
        if (found) print out; else print ""
    }'
}

cmd_boot() {
    load_state
    boot=$(boot_id)
    if [ -z "$boot" ]; then log "no boot id: not armed"; exit 0; fi
    # the last armed start's outcome (a second run in the same start counts nothing)
    if [ -n "$armed" ] && [ "$armed" != "$boot" ]; then
        mark=$(cat "$SHUTDOWN" 2>/dev/null)
        result=none
        [ "${mark%% *}" = "$armed" ] && result=${mark#* }
        case $result in
        failed) fails=$((fails + 1)); why="carplay had failed at its shutdown" ;;
        running|stopped)
            if [ "$healthy" = "$armed" ]; then fails=0; why="healthy, carplay $result at its shutdown"
            else why="carplay $result at its shutdown, never healthy: not counted"; fi ;;
        *)  if [ "$healthy" = "$armed" ]; then why="healthy, no shutdown mark: not counted"
            else fails=$((fails + 1)); why="no shutdown mark and never healthy"; fi ;;
        esac
        log "last armed start: $why (failed starts: $fails)"
    fi
    armed=
    rm -f "$RUN/env" 2>/dev/null

    reason=
    if [ -e "$VAR/disabled" ]; then reason="disabled"
    elif [ "$fails" -ge "$THRESHOLD" ]; then reason="off after $fails failed starts (reset to try again)"
    elif [ ! -r "$ROOT$PRELOAD" ]; then reason="$PRELOAD missing"
    else
        sum=$(sha256sum "$LIB" 2>/dev/null); sum=${sum%% *}
        if [ "$sum" != "$LIB_SHA256" ]; then reason="libNmeCarPlay.so is not the build the hook is for"
        elif ! stock=$(stock_preload); then reason="carplay.service's environment unreadable"
        fi
    fi
    if [ -z "$reason" ]; then
        # ours after the stock preload (EnvironmentFile overrides Environment=, so both go here)
        case " $stock " in *" $PRELOAD "*) pre=$stock ;; *) pre=${stock:+$stock }$PRELOAD ;; esac
        mkdir -p "$RUN" && chmod 0755 "$RUN" 2>/dev/null
        {
            echo "LD_PRELOAD=\"$pre\""
            # HOOK111_*=<number> lines of an optional config, nothing else
            if [ -r "$VAR/config" ]; then grep -E '^HOOK111_(SINK_PORT|DATA_PORT)=[0-9]{1,5}$' "$VAR/config"; fi
            true   # no config, or no line in it, is no failure
        } >"$RUN/env.tmp" 2>/dev/null && chmod 0644 "$RUN/env.tmp" && mv -f "$RUN/env.tmp" "$RUN/env" || reason="cannot write $RUN/env"
    fi
    if [ -z "$reason" ]; then
        # the hook's plist log (it writes there only if the directory exists),
        # owned by carplay's user; on /run, so gone at the next reboot
        u=$(bounded 5 "$SYSTEMCTL" show carplay.service -p User); u=${u#User=}
        if mkdir -p "$RUN/log" 2>/dev/null && [ -n "$u" ] && chown "$u:$u" "$RUN/log" 2>/dev/null; then chmod 0755 "$RUN/log"
        else rm -rf "$RUN/log"; log "no plist log (carplay's user: ${u:-unknown})"; fi
        armed=$boot; last="armed $boot"
        if ! save_state; then
            # an unsaved arm would never be counted: do not arm
            rm -f "$RUN/env"; armed=; log "cannot save state: not armed"; exit 0
        fi
        log "armed: LD_PRELOAD=\"$pre\""
    else
        last="not armed: $reason"; save_state
        log "not armed: $reason"
    fi
    exit 0
}

cmd_mark() {
    boot=$(boot_id)
    [ -n "$boot" ] || exit 0
    out=$(bounded 3 "$SYSTEMCTL" show carplay.service -p ActiveState -p Result) || exit 0
    act=; res=
    for l in $out; do case $l in ActiveState=*) act=${l#*=} ;; Result=*) res=${l#*=} ;; esac; done
    if [ "$act" = failed ] || { [ -n "$res" ] && [ "$res" != success ]; }; then r=failed
    elif [ "$act" = active ] || [ "$act" = activating ] || [ "$act" = reloading ]; then r=running
    else r=stopped; fi
    mkdir -p "$VAR" 2>/dev/null
    echo "$boot $r" >"$SHUTDOWN.tmp" 2>/dev/null && sync && mv -f "$SHUTDOWN.tmp" "$SHUTDOWN" && sync
    exit 0
}

cmd_health() {
    boot=$(boot_id)
    load_state
    [ -n "$boot" ] && [ "$armed" = "$boot" ] || { log "health: not armed this start"; exit 0; }
    pid_seen=; since=0; t=0
    while [ "$t" -lt "$HEALTH_GIVE_UP" ]; do
        out=$(bounded 5 "$SYSTEMCTL" show carplay.service -p MainPID -p ActiveState)
        pid=; act=
        for l in $out; do case $l in MainPID=*) pid=${l#*=} ;; ActiveState=*) act=${l#*=} ;; esac; done
        if [ "$act" = active ] && [ -n "$pid" ] && [ "$pid" != 0 ] && grep -q "libhook111.so" "$PROC/$pid/maps" 2>/dev/null; then
            [ "$pid" = "$pid_seen" ] || { pid_seen=$pid; since=$t; }
            if [ $((t - since)) -ge "$HEALTHY_AFTER" ]; then
                load_state; healthy=$boot; last="healthy $boot"; save_state
                log "healthy: carplay $pid ran ${HEALTHY_AFTER} s with the hook"; exit 0
            fi
        else pid_seen=; fi
        sleep 1; t=$((t + 1))
    done
    log "health: gave up after ${HEALTH_GIVE_UP} s"; exit 0
}

case ${1:-} in
boot) cmd_boot ;;
mark) cmd_mark ;;
health) cmd_health ;;
status) load_state; echo "failed starts: $fails (off at $THRESHOLD)"; echo "armed: ${armed:-no}"; echo "healthy: ${healthy:-no}"
        echo "last: $last"; [ -e "$VAR/disabled" ] && echo "disabled"; [ -r "$RUN/env" ] && { echo "this start:"; cat "$RUN/env"; }; exit 0 ;;
disable) mkdir -p "$VAR" && touch "$VAR/disabled" && sync; log "disabled from the next start"; exit 0 ;;
enable) rm -f "$VAR/disabled"; sync; log "enabled from the next start"; exit 0 ;;
reset) load_state; fails=0; rm -f "$VAR/disabled"; last="reset"; save_state; log "reset: the hook arms at the next start"; exit 0 ;;
*) echo "usage: $0 boot|mark|health|status|disable|enable|reset" >&2; exit 0 ;;
esac
