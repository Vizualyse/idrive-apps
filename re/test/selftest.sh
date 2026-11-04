#!/bin/sh
# Runs inside the idrive-re container (re/run.sh selftest). Builds synthetic
# binaries (no BMW or Cinemo bytes) that stand in for the cases that matter,
# then checks survey.py and ExportAltScreen.java report exactly those:
#
#   rootfs: usr/bin/carplay -> libNmeCarPlay.so (v1: one screen, no alt vocabulary)
#   host:   carplay2 -> libNmeCarPlay.so v2 (exports nme_alt_screen_open, has
#           "altScreen"/"viewAreas" and a 110/111 switch) + libextra.so
#
# Surveying carplay2 against the rootfs must report libextra.so missing and
# nme_alt_screen_open unresolved; v2 under Ghidra must show the keyword's
# referencing function and the 110/111 function.
set -eu
W=/tmp/st; rm -rf $W; mkdir -p $W/v1 $W/v2 $W/fs/usr/bin $W/fs/usr/lib $W/host $W/out
cd $W
fail=0
ok() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }

cat > v1/nme.c <<'EOF'
const char *nme_info(void) { return "displays widthPixels heightPixels maxFPS"; }
int nme_screen_open(int type) { return type == 110 ? 0 : -1; }
EOF
cat > v2/nme.c <<'EOF'
#include <string.h>
const char *nme_info(void) { return "displays widthPixels heightPixels maxFPS"; }
const char *nme_features(void) { return "altScreen"; }
const char *nme_views(void) { return "viewAreas"; }
int nme_screen_open(int type) {
    switch (type) { case 110: return 1; case 111: return 2; default: return -1; }
}
int nme_alt_screen_open(const char *f) { return strcmp(f, nme_features()) == 0 ? nme_screen_open(111) : -1; }
#include <stdio.h>
int nme_logged(int x) { puts("AirPlayReceiverSessionScreen_ProcessFrames"); return x + 1; }
EOF
echo 'int extra(void) { return 7; }' > host/extra.c
cat > v1/main.c <<'EOF'
int nme_screen_open(int);
int main(void) { return nme_screen_open(110); }
EOF
cat > host/main.c <<'EOF'
int nme_screen_open(int); int nme_alt_screen_open(const char *); int extra(void);
int main(void) { return nme_screen_open(110) + nme_alt_screen_open("altScreen") + extra(); }
EOF

gcc -shared -fPIC -O1 -Wl,-soname,libNmeCarPlay.so -o v1/libNmeCarPlay.so v1/nme.c
gcc -shared -fPIC -O1 -Wl,-soname,libNmeCarPlay.so -o v2/libNmeCarPlay.so v2/nme.c
gcc -shared -fPIC -O1 -Wl,-soname,libextra.so -o host/libextra.so host/extra.c
gcc -O1 -Wl,--build-id -o fs/usr/bin/carplay v1/main.c -Lv1 -lNmeCarPlay
gcc -O1 -Wl,--build-id -o host/carplay2 host/main.c -Lv2 -Lhost -lNmeCarPlay -lextra
cp v1/libNmeCarPlay.so fs/usr/lib/
cp -L /lib/x86_64-linux-gnu/libc.so.6 /lib64/ld-linux-x86-64.so.2 fs/usr/lib/   # the closure ends at libc and the loader

echo "== survey, the rootfs's own carplay"
python3 /re/survey.py --rootfs fs --out out/own > /dev/null
ok "own: carplay and libNmeCarPlay found" \
   "python3 -c \"import json;r=json.load(open('out/own/survey.json'));assert sorted(r['targets'])==['usr/bin/carplay','usr/lib/libNmeCarPlay.so']\""
ok "own: nothing missing, nothing unresolved" \
   "python3 -c \"import json;r=json.load(open('out/own/survey.json'));assert r['closure']['missing']==[] and not r['unresolved_symbols']\""
ok "own: v1 has no altScreen" \
   "python3 -c \"import json;r=json.load(open('out/own/survey.json'));assert 'altScreen' not in r['targets']['usr/lib/libNmeCarPlay.so']['keyword_hits']\""
ok "own: v1 has displays" \
   "python3 -c \"import json;r=json.load(open('out/own/survey.json'));assert 'displays' in r['targets']['usr/lib/libNmeCarPlay.so']['keyword_hits']\""

echo "== survey, a newer carplay against this rootfs (the swap check)"
python3 /re/survey.py --rootfs fs --out out/swap --target host/carplay2 > /dev/null
ok "swap: libextra.so missing" \
   "python3 -c \"import json;r=json.load(open('out/swap/survey.json'));assert r['closure']['missing']==['libextra.so']\""
ok "swap: nme_alt_screen_open and extra unresolved" \
   "python3 -c \"import json;r=json.load(open('out/swap/survey.json'));s=sorted(x['symbol'] for x in r['unresolved_symbols']['carplay2']);assert s==['extra','nme_alt_screen_open'],s\""
ok "swap: md written" "grep -q 'nme_alt_screen_open' out/swap/survey.md"

echo "== ghidra on v2"
mkdir -p /tmp/gp
/opt/ghidra/support/analyzeHeadless /tmp/gp p -import v2/libNmeCarPlay.so -scriptPath /re/ghidra \
    -postScript ExportAltScreen.java $W/out/v2.tsv -postScript ExportLogNames.java $W/out/v2.names.tsv -deleteProject > out/ghidra.log 2>&1 || { tail -30 out/ghidra.log; exit 1; }
ok "ghidra: altScreen referenced from nme_features" "grep -P '^kw\taltScreen\t.*\tnme_features@' out/v2.tsv >/dev/null"
ok "ghidra: viewAreas referenced from nme_views" "grep -P '^kw\tviewAreas\t.*\tnme_views@' out/v2.tsv >/dev/null"
ok "ghidra: nme_screen_open uses 110 and 111" "grep -P '^scalar\tnme_screen_open@' out/v2.tsv >/dev/null"
ok "ghidra: log name maps to its function" "grep -P '^name	AirPlayReceiverSessionScreen_ProcessFrames	1	nme_logged@' out/v2.names.tsv >/dev/null"
ok "ghidra: function list exported" "grep -P '^func\tnme_alt_screen_open\t' out/v2.tsv >/dev/null"

[ $fail -eq 0 ] && echo "selftest: all passed" || { echo "selftest: FAILED"; exit 1; }
