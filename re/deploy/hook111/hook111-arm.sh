#!/bin/sh
# hook111-arm.sh: decide, once per head-unit start, whether carplay starts with
# the stream-111 hook (libhook111.so) preloaded. busybox ash (the unit's /bin/sh).
#
#   boot     hook111-arm.service, Before=carplay.service: count the last armed
#            start's outcome, then write /run/hook111/env (or not)
#   mark     var-opt-ro.service drop-in, before /var/opt goes read-only at a
#            shutdown or crash reboot: record how carplay is doing
#   health   hook111-health.service, for the whole armed start: a carplay that
#            has run 60 s with the hook loaded marks the start healthy; a
#            carplay run that ends failed marks it crashed at once (the reboot
#            follows within seconds), whatever the shutdown mark does
#   status | disable | enable | reset
#
# Nothing on / changes. The env file is on /run (tmpfs): every reboot, a crash
# reboot included, starts stock unless this step arms it again. carplay's
# drop-in only reads it (EnvironmentFile=-/run/hook111/env). This script never
# stops, kills or restarts anything, and always exits 0.
#
# Counting: the last armed start counts as failed when the watcher saw carplay
# crash, when carplay had failed at its shutdown mark, or when it has no mark
# and never got healthy (power lost, a crash before anything was recorded). It
# counts as good (the counter is cleared) when it got healthy, did not crash,
# and carplay was running or stopped at the mark. The mark is not always
# written (it was not at a `systemctl reboot` on the unit, 2026-11-04), so the
# watcher is what catches a crash after the start was healthy.
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
WATCH_FOR=${HOOK111_WATCH_FOR:-0}              # seconds the watcher runs; 0: the whole start (tests set it)

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

# state: fails=N armed=<boot id> healthy=<boot id> crashed=<boot id> last=<text> (ids or empty)
fails=0 armed= healthy= crashed= last=
load_state() {
    [ -f "$STATE" ] || return 0
    while IFS='=' read -r k v; do
        case $k in
        fails) case $v in ''|*[!0-9]*) fails=$THRESHOLD ;; *) fails=$v ;; esac ;;   # unreadable: stay off
        armed) armed=$v ;; healthy) healthy=$v ;; crashed) crashed=$v ;; last) last=$v ;;
        esac
    done <"$STATE"
}
save_state() {   # whole, or not at all: temp file, sync, rename
    mkdir -p "$VAR" 2>/dev/null
    _t="$STATE.tmp.$$"
    { echo "fails=$fails"; echo "armed=$armed"; echo "healthy=$healthy"; echo "crashed=$crashed"; echo "last=$last"; } >"$_t" 2>/dev/null \
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
        [ "$crashed" = "$armed" ] && result=crashed
        case $result in
        crashed) fails=$((fails + 1)); why="the watcher saw carplay crash" ;;
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

# carplay.service's MainPID, ActiveState and Result, into cp_pid cp_act cp_res
cp_query() {
    cp_pid=; cp_act=; cp_res=
    _o=$(bounded 5 "$SYSTEMCTL" show carplay.service -p MainPID -p ActiveState -p Result) || return 1
    for _l in $_o; do case $_l in MainPID=*) cp_pid=${_l#*=} ;; ActiveState=*) cp_act=${_l#*=} ;; Result=*) cp_res=${_l#*=} ;; esac; done
    [ "$cp_pid" = 0 ] && cp_pid=
    return 0
}

record_crash() {
    load_state; crashed=$boot; last="crashed $boot: $1"
    if save_state; then log "carplay crashed ($1): recorded"; else log "carplay crashed ($1): could not record it"; fi
}

cmd_health() {
    boot=$(boot_id)
    load_state
    [ -n "$boot" ] && [ "$armed" = "$boot" ] || { log "health: not armed this start"; exit 0; }
    pid=; since=0; t=0; marked=0; last_q=-100
    while [ "$WATCH_FOR" = 0 ] || [ "$t" -lt "$WATCH_FOR" ]; do
        if [ -n "$pid" ] && [ ! -d "$PROC/$pid" ]; then
            # the run we watched is gone: ask until systemd has its result (a few seconds)
            i=0
            while [ $i -lt 5 ]; do
                cp_query
                if [ "$cp_act" = failed ] || { [ -n "$cp_res" ] && [ "$cp_res" != success ]; }; then
                    sys=$(bounded 5 "$SYSTEMCTL" is-system-running)
                    if [ "$sys" = stopping ]; then log "carplay ended while the system stops: not a crash"
                    else record_crash "ActiveState=$cp_act Result=$cp_res"; fi
                    exit 0
                fi
                [ "$cp_act" = active ] && [ -n "$cp_pid" ] && [ "$cp_pid" != "$pid" ] && break   # a new run, the old one ended cleanly
                [ "$cp_act" = inactive ] && break
                sleep 1; i=$((i + 1)); t=$((t + 1))
            done
            pid=; last_q=$t
        elif [ $((t - last_q)) -ge 5 ] || [ -z "$pid" ]; then
            cp_query; last_q=$t
            if [ "$cp_act" = failed ] || { [ -n "$cp_res" ] && [ "$cp_res" != success ]; }; then
                # this armed start's carplay failed, also before the watcher first looked (a crash at load)
                sys=$(bounded 5 "$SYSTEMCTL" is-system-running)
                [ "$sys" = stopping ] || record_crash "ActiveState=$cp_act Result=$cp_res"
                exit 0
            elif [ "$cp_act" = active ] && [ -n "$cp_pid" ] && [ -d "$PROC/$cp_pid" ]; then
                [ "$cp_pid" = "$pid" ] || { pid=$cp_pid; since=$t; }
            fi
        fi
        if [ "$marked" = 0 ] && [ -n "$pid" ] && [ $((t - since)) -ge "$HEALTHY_AFTER" ] && grep -q "libhook111.so" "$PROC/$pid/maps" 2>/dev/null; then
            load_state; healthy=$boot; last="healthy $boot"; save_state; marked=1
            log "healthy: carplay $pid ran ${HEALTHY_AFTER} s with the hook; still watching"
        fi
        sleep 1; t=$((t + 1))
    done
    log "health: watched ${WATCH_FOR} s"; exit 0
}

case ${1:-} in
boot) cmd_boot ;;
mark) cmd_mark ;;
health) cmd_health ;;
status) load_state; echo "failed starts: $fails (off at $THRESHOLD)"; echo "armed: ${armed:-no}"; echo "healthy: ${healthy:-no}"; echo "crashed: ${crashed:-no}"
        echo "last: $last"; [ -e "$VAR/disabled" ] && echo "disabled"; [ -r "$RUN/env" ] && { echo "this start:"; cat "$RUN/env"; }; exit 0 ;;
disable) mkdir -p "$VAR" && touch "$VAR/disabled" && sync; log "disabled from the next start"; exit 0 ;;
enable) rm -f "$VAR/disabled"; sync; log "enabled from the next start"; exit 0 ;;
reset) load_state; fails=0; rm -f "$VAR/disabled"; last="reset"; save_state; log "reset: the hook arms at the next start"; exit 0 ;;
*) echo "usage: $0 boot|mark|health|status|disable|enable|reset" >&2; exit 0 ;;
esac
