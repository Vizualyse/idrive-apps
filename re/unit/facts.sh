#!/bin/sh
# Runs ON the head unit (fed over ssh by pull_unit.sh). Read-only: it prints
# facts and changes nothing. It never stops, restarts or signals carplay
# (a CarPlay death power-cycles the head unit).

section() { printf '\n### %s\n' "$1"; }

section uname;        uname -a
section os-release;   cat /etc/os-release 2>&1
section version-files
for f in /etc/version /etc/*version* /etc/*release* /etc/issue /etc/build /etc/buildinfo; do
    [ -f "$f" ] && { echo "== $f"; head -c 4096 "$f"; echo; }
done
section mounts;       cat /proc/mounts
section df;           df -k 2>&1
section tar;          (tar --help 2>&1 | head -3); command -v tar
section hash-tools;   command -v sha256sum md5sum 2>&1

section carplay-files
for f in /usr/bin/carplay $(find / -xdev \( -name 'libNme*' -o -name 'libCinemo*' -o -name '*cinemo*' \) 2>/dev/null); do
    ls -la "$f"; sha256sum "$f" 2>/dev/null
done

section carplay-service
systemctl cat carplay.service 2>&1
systemctl show carplay.service -p ExecStart -p Environment -p DropInPaths 2>&1

PID=$(pidof carplay 2>/dev/null | cut -d' ' -f1)
section carplay-process
echo "pid=${PID:-none}"
if [ -n "$PID" ]; then
    echo "== cmdline"; tr '\0' ' ' < /proc/$PID/cmdline; echo
    echo "== environ"; tr '\0' '\n' < /proc/$PID/environ
    echo "== loaded objects (from maps)"
    awk '$6 ~ /^\// {print $6}' /proc/$PID/maps | sort -u
    echo "== listening sockets"
    (ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -i carplay
fi

section packages
(opkg list-installed 2>/dev/null || rpm -qa 2>/dev/null || cat /var/lib/opkg/status 2>/dev/null) \
    | grep -iE 'carplay|cinemo|nme|airplay|iap' | head -100
