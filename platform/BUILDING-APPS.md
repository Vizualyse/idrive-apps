# Building an app on the Vizualyse platform

How to make a new iDrive 7 app in this repository: what the pieces are,
what each file must say, how the shared platform code goes in, how to test it
off the car and how it reaches the Store. It is written from the four apps we
ship (Cast, Moonlight, Browser, Steam) and from [`knowledge/`](../knowledge/index.md);
links point at the real code to copy from.

The running example is a made-up app, **Foo**: a tool `vizualyse-foo` that
shows something on the central screen with sound, and its iDrive app
`vizualyse_foo` with a status line, Play / Stop / Show, the phone link as a QR
code and an on / off switch.

Contents:

1. [What you are building](#1-what-you-are-building)
2. [Rules the head unit enforces](#2-rules-the-head-unit-enforces)
3. [Pick your numbers](#3-pick-your-numbers)
4. [Folder layout](#4-folder-layout)
5. [The tool](#5-the-tool)
6. [The iDrive app](#6-the-idrive-app)
7. [The platform in your app](#7-the-platform-in-your-app)
8. [Testing off the car](#8-testing-off-the-car)
9. [Releasing](#9-releasing)
10. [On the car](#10-on-the-car)
11. [Checklist](#11-checklist)

## 1. What you are building

Every app here is **two Store components** that the Store installs together:

```
                         phone (on the car's hotspot)
                               | HTTP, token in the QR link, wlan0
                               v
 iDrive app  <-- ctl.sock -->  tool (systemd service, root)  --> central screen (mgu-render)
 (OAP, RHMI page)  JSON lines   native/vizualyse-foo          --> cluster / HUD (cluster-render)
 apps/vizualyse_foo                                            --> speakers (SmartXbar, mgu-python)
   reads the car's speed                                       --> internet (mgu-uplink, its own uid)
```

- **The tool** (`native/vizualyse-foo`, kind `tool`) is a root systemd
  service, Node 8.16, installed into `/var/opt/vizualyse-foo/current/`. It
  does all the work: it can draw on the screens, play sound, open ports, run
  programs as other users. It serves the **phone page** (typing, settings,
  anything that needs a keyboard) and a **control socket** for its app.
- **The iDrive app** (`apps/vizualyse_foo`, kind `app`) is an OAP Online App:
  one RHMI page in the iDrive menu, running as its own unprivileged uid
  under MainApp. It is a remote control: status, a few buttons, the phone
  link and its QR code. It also reads the car's speed and hands it to the
  tool, because the tool can't easily read vehicle data and the app can.

The app does nothing alone; the tool runs without the app (its phone page
works), but nothing shows on the central screen unless the app says so,
because only the app knows whether its page is in front.

You don't always need both: hook111 is a tool with no app (an extension for
Cast). An app with no tool is possible but can't draw outside its RHMI page,
play sound or reach the internet as anything but itself.

## 2. Rules the head unit enforces

Read these before writing code. Each one has cost us a reboot, a wipe or a
silent failure ([head-unit.md](../knowledge/head-unit.md), [store.md](../knowledge/store.md)).

| Rule | What happens otherwise | What we do |
|---|---|---|
| A systemd service stopped or restarted must be on **recmgr's whitelist** | the unit restarts (four times on 2026-11-05) | `component.json` `"recmgr": ["vizualyse-foo"]`; never hand-make a trial unit |
| A program that dumps core must be on **crashhandler's list** | the unit restarts | `"crashNames"` for every program you start; `LimitCORE=1` in the unit |
| **Never let an iDrive app crash or be killed** | first time its data is wiped, second time it is uninstalled | catch every promise; stay resident on a failed start |
| **Never claim touch through mgu-render** | the unit restarted twice | read touches passively (platform `native/touch.c`) |
| **No GPU driver of ours** | Mesa 22's ANV hung the kernel; the unit restarted on every boot | use the unit's own Mesa 19 (`i965`); anything risky on by hand, never kept across a start |
| Root has **no internet** and no route to the hotspot's subnet | connections fail | run network work as the tool's own uid, listed in `"uids"` |
| The unit's resolver doesn't resolve internet names | DNS fails | resolve through the phone's DNS (`/run/mgu-uplink/lease.json`) |
| The firewall ends in a drop | the phone can't reach your page | insert an `ip filter input` rule for your port on `wlan0` while on, remove it on off and in `deactivate` |
| Every Store app shares the group `tm_oap_app` | any app could drive your tool | the control socket goes to your app's own group (platform pattern below) |
| Dynamic loader is `/lib/ld-linux-x86-64.so.2`, glibc 2.27, no `/lib64` | a binary built on a normal distro says "not found" | build in Ubuntu 18.04 with `-Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2`, or bundle your own loader |
| Root first opening a SmartX stream leaves a root-owned lock | CarPlay is silent until a restart | play through the platform's `pcm_play.py` (it makes the lock as the system does) |
| The journal is in RAM and rotates in minutes | your evidence is gone after a restart | write markers to `/var/opt/vizualyse-foo/state` |
| Nothing on the central screen while moving | unsafe, and BMW's own apps don't | the app sends the speed; the tool hides above 3 km/h |

## 3. Pick your numbers

Every app needs ids, a port, a uid and two paths no other app uses:

| | Cast | Moonlight | Browser | Steam | **Foo** |
|---|---|---|---|---|---|
| tool id | `vizualyse-cast` | `vizualyse-moonlight` | `vizualyse-chromium` | `vizualyse-steam` | `vizualyse-foo` |
| app id | `vizualyse_cast` | `vizualyse_moonlight` | `vizualyse_chromium` | `vizualyse_steam` | `vizualyse_foo` |
| phone page | 8480 | 8490 | 8491 | 8494 | **8495** |
| other ports | 8481 proxy | UDP 47998-48000 in | 8492 local, 8483 proxy | | |
| uplink uid | 12999 | 12998 | 12997 | 12996 | **12995** |
| control socket | `/dev/shm/<tool id>/ctl.sock` | | | | `/dev/shm/vizualyse-foo/ctl.sock` |
| frame file | `/dev/shm/mgu-video-<app id>` | | | | `/dev/shm/mgu-video-vizualyse_foo` |

- **Tool ids** are lower case with hyphens (`[a-z0-9][a-z0-9-]*`).
- **App ids** must start with `vizualyse_` (`release.js` refuses others: a
  provisioning id such as `store` would hide the tile).
- **The uid** must not be a MainApp uid (12203-12450, 12453-12700); we count
  down from 12999.
- Grep for the port and uid before you take them: `git grep -n 8495 12995`.

## 4. Folder layout

```
native/vizualyse-foo/                 the tool
  component.json                      what the Store installs, and the platform pin
  README.md                           what it does, how it works, off the car, on the car
  THIRD-PARTY.md                      what it ships that isn't ours (shipped in the kit)
  LICENSE                             GPL-3.0-or-later
  build.sh                            optional: builds native parts in Docker
  systemd/vizualyse-foo.service
  src/
    server.js                         the tool: phone page, control socket, the work
    control.js  firewall.js           copied from Steam for now (section 7)
    screen.js                         the mgu-render layer, if you draw on the central screen
    page.html                         the phone page
    .gitignore                        written by platform sync: lists the platform copies
    pcm_play.py                       platform copy (not committed)
  test/                               not shipped
  tools/                              not shipped

apps/vizualyse_foo/                   the iDrive app
  release.json                        Store fields and the platform pin
  mgu-app.json                        the source package: modules, staged tree, SDK names
  README.md  LICENSE
  src/
    vizualyse_foo.js                  the app (entry module)
    foo_control.js                    the app's end of the control socket
    .gitignore                        written by platform sync
    qr_png.js  qrcode.js  vehicle_speed.js   platform copies (not committed)
  tools/
    build.js  make_page.js  make_icon.js  test_page.js
  vizualyse_foo@0.1.0/                the staged tree: the OAP package minus its code
    package.json  manifest.json  permissions.json  npm-shrinkwrap.json
    CHANGELOG.md  LICENSE  config/base.json
    rhmiData/application.json
    rhmiData/uiDescriptions/ID7/application.xml     generated by make_page.js
    rhmiData/uiDescriptions/ID7/uiDescription.json  generated by make_page.js
    rhmiData/variantGroups/Common/texts/en_GB.json
    rhmiData/variantGroups/Common/images/vizualyse_foo_icon.png
```

**Start by copying the Steam pair** (`native/vizualyse-steam`,
`apps/vizualyse_steam`): it has the most complete app (a screen state for
covering the app area, Play buttons, a download row) and the simplest tool
scaffold. Copy Moonlight's for the cluster or HUD, Cast's for a tool with no
speed gate. Then rename everything (`steam` → `foo`, `Steam` → `Foo`,
`STEAM_` → `FOO_`, `VSTM` → a new log id) and delete what you don't need.

## 5. The tool

### 5.1 component.json

What the Store reads to install the tool, and what `release.js` reads to
build and catalogue it. Annotated (JSON has no comments: these are
explanations, not file content):

```jsonc
{
  "id": "vizualyse-foo",
  "kind": "tool",
  "version": "0.1.0",                       // bump on every shipped change (section 9)
  "license": "GPL-3.0-or-later",
  "title": "Foo",                           // the Store's title
  "description": "EXPERIMENTAL. What it does, what it needs, how big it is.",
  "requires": {                             // other Store components, minimum versions
    "mgu-deploy": "0.7.0",                  //   always: the deploy tool that runs hooks
    "mgu-python": "1.0.0",                  //   for pcm_play.py
    "mgu-render": "0.6.11"                  //   for the central screen
  },                                        //   (+ "cluster-render": "0.3.3", "mgu-uplink": "0.7.0")
  "uninstallable": true,                    // the Store offers Remove
  "mguHmi": ["ID7"],
  "internet": true,                         // the uplink routes the uids below
  "uids": [12995],
  "deactivate": ["node", "firewall.js", "remove"],   // root hook on removal: drop the firewall rule
  "build": ["sh", "build.sh"],              // optional: runs in the tool folder before packing
  "platform": {                             // section 7: a version per module
    "tool/pcm_play": { "version": "1.0.0", "files": { "src/pcm_play.py": "pcm_play.py" } }
  },
  "files": [                                // what lands in /var/opt/vizualyse-foo/current/
    { "path": "server.js",   "from": "src/server.js",   "mode": "0644" },
    { "path": "control.js",  "from": "src/control.js",  "mode": "0644" },
    { "path": "firewall.js", "from": "src/firewall.js", "mode": "0644" },
    { "path": "screen.js",   "from": "src/screen.js",   "mode": "0644" },
    { "path": "pcm_play.py", "from": "src/pcm_play.py", "mode": "0644" },
    { "path": "page.html",   "from": "src/page.html",   "mode": "0644" },
    { "path": "THIRD-PARTY.md", "from": "THIRD-PARTY.md", "mode": "0644" },
    { "path": "LICENSE",     "from": "LICENSE",         "mode": "0644" }
  ],
  "units": [{ "name": "vizualyse-foo.service", "from": "systemd/vizualyse-foo.service" }],
  "enable": [{ "unit": "vizualyse-foo.service", "target": "multi-user.target" }],
  "recmgr": ["vizualyse-foo"],              // section 2: or stopping it restarts the unit
  "crashNames": ["foo-helper"],             // every program you start that isn't node/python
  "restart": ["vizualyse-foo.service"]      // restarted after an update
}
```

Notes:

- `files[].path` is **flat**: no kit we ship has subfolders, and the code
  finds its files with `path.join(__dirname, name)`. Keep it that way.
- Executables still ship `0644`; start them with `spawn(process.execPath,
  ...)`, `sh`, or `chmod` them at start (Moonlight's `moonlight-core`).
- Big payloads (Chromium, Proton) ship as `.tgz` files in `files[]` and are
  unpacked at first start into `/var/opt/<tool>/` (`src/unpack.js` in
  Browser and Steam: a streaming tar reader, a sha256 stamp, swapped in by
  rename).
- Other fields the Store knows (`keepRunning`, `postInstall`, `check`,
  `activate`, `dropins`, `preload`...) are in [store.md](../knowledge/store.md).

### 5.2 The systemd unit

```ini
# systemd/vizualyse-foo.service
[Unit]
Description=vizualyse-foo: what it does, in one line
RequiresMountsFor=/var/opt
After=mgu-render.service mgu-uplink.service
Wants=mgu-render.service

[Service]
# Root: the renderer, nftables, the frame file. Network work runs as uid 12995.
ExecStart=/usr/bin/node /var/opt/vizualyse-foo/current/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
KillMode=mixed
TimeoutStopSec=20
# 1, not 0: the kernel then skips even a piped core handler (section 2)
LimitCORE=1

[Install]
WantedBy=multi-user.target
```

`StandardOutput=journal` matters: the unit's systemd defaults output to
null. Log one line per event with a short prefix (`web:`, `control:`,
`screen:`, `foo:`) so `journalctl -u vizualyse-foo | grep` finds it.

### 5.3 server.js

The tool is one long-running process. Its parts, in the order they appear in
Steam's [`server.js`](../native/vizualyse-steam/src/server.js):

1. **Constants**, each overridable by an environment variable so the tests
   can move them: the port, the state folder, the uid, the lease file, the
   view (where on the screen), `MAX_KMH = 3`.
2. **State** in `/var/opt/vizualyse-foo/state` (root, 0700): the page token,
   `settings.json` (on / off and the rest), markers such as
   `game-running`. Write JSON through a `.tmp` file and `rename`, so a
   power cut never leaves half a file.
3. **The phone page**: an HTTP server on `0.0.0.0:PORT`. Every request
   carries the token (`?t=` or a header), compared with
   `crypto.timingSafeEqual`; no token, 403. Off, 503. `GET /` is
   `page.html`, `GET /api/status` the status, `POST /api/<verb>` the
   commands, each answering the new status.
4. **The link**: `http://<uplink ip>:PORT/?t=<token>`, the ip from
   `/run/mgu-uplink/lease.json` (`ip`), else `wlan0`'s address. The app
   draws it as a QR code.
5. **status()**: one plain object that both the phone page and the app read.
   Put everything either needs in it: `enabled`, `link`, what is running,
   `shown`, `moving`, the last error.
6. **command(c)**: the control socket's commands; returns an error string or
   `null`. The same functions as the phone page's routes.
7. **The parked gate**: the app sends the speed once a second; `moving()` is
   true above `MAX_KMH` for a reading under 10 s old. Moving hides the
   picture and refuses `show`.
8. **On / off**: kept in settings. Off stops everything, removes the
   firewall rule and closes the page (503); the control socket stays so the
   app can turn it back on.
9. **Shutdown** on SIGTERM / SIGINT: hide, stop children, remove the
   firewall rule, close the sockets, exit within the unit's
   `TimeoutStopSec`.

A minimal skeleton (from Steam's, cut down):

```js
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { startControl } = require('./control.js');
const firewall = require('./firewall.js');

const HERE = __dirname;
const PORT = Number(process.env.FOO_PORT) || 8495;
const IFNAME = 'wlan0';
const LEASE = process.env.FOO_LEASE || '/run/mgu-uplink/lease.json';
const STATE_DIR = process.env.FOO_STATE || '/var/opt/vizualyse-foo/state';
const NO_FIREWALL = process.env.FOO_NO_FIREWALL === '1';
const MAX_KMH = 3;
const log = (s) => console.log(new Date().toISOString() + ' ' + s);

function mkdirp(d) { if (!fs.existsSync(d)) { mkdirp(path.dirname(d)); fs.mkdirSync(d, 0o700); } }
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
function writeJson(f, obj) {
    mkdirp(path.dirname(f));
    fs.writeFileSync(f + '.tmp', JSON.stringify(obj, null, 1) + '\n', { mode: 0o600 });
    fs.renameSync(f + '.tmp', f);
}

function token() {
    const f = path.join(STATE_DIR, 'token');
    try { const t = fs.readFileSync(f, 'utf8').trim(); if (/^[0-9a-f]{16}$/.test(t)) return t; } catch (e) { /* new */ }
    const t = crypto.randomBytes(8).toString('hex');
    mkdirp(STATE_DIR);
    fs.writeFileSync(f, t + '\n', { mode: 0o600 });
    return t;
}
const TOKEN = token();

function uplinkIp() {
    const l = readJson(LEASE);
    if (l && l.ip) return l.ip;
    const v4 = (os.networkInterfaces()[IFNAME] || []).filter((a) => a.family === 'IPv4' && !a.internal)[0];
    return v4 ? v4.address : null;
}
function link() { const ip = uplinkIp(); return ip ? 'http://' + ip + ':' + PORT + '/?t=' + TOKEN : null; }

const SETTINGS_FILE = path.join(STATE_DIR, 'settings.json');
const settings = Object.assign({ enabled: true }, readJson(SETTINGS_FILE));
function saveSettings() { try { writeJson(SETTINGS_FILE, settings); } catch (e) { log('settings: ' + e.message); } }

/* ---- the car's speed (from the app) ---- */
const vehicle = { kmh: null, at: 0 };
function moving() { return vehicle.kmh !== null && vehicle.kmh > MAX_KMH && Date.now() - vehicle.at < 10000; }
function setSpeed(kmh) {
    if (typeof kmh !== 'number' || !isFinite(kmh)) return;
    const was = moving();
    vehicle.kmh = kmh; vehicle.at = Date.now();
    if (moving() && !was) hide('the car is moving');
}

/* ---- the work ---- */
let running = false, shown = false, lastError = null;
function play() { if (moving()) return 'only while parked'; running = true; return null; }
function stop(why) { hide(why); running = false; log('foo: stopped (' + why + ')'); return null; }
function show() { if (!running) return 'nothing is playing'; if (moving()) return 'only while parked'; shown = true; return null; }
function hide(why) { if (shown) log('foo: hidden (' + why + ')'); shown = false; }

function status() {
    return { enabled: settings.enabled, link: settings.enabled ? link() : null,
        running: running, shown: shown, speed: vehicle.kmh, moving: moving(), error: lastError };
}

/* ---- the phone page ---- */
const PAGE = fs.readFileSync(path.join(HERE, 'page.html'), 'utf8');
function send(res, code, type, body) {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
}
function json(res, code, obj) { send(res, code, 'application/json', JSON.stringify(obj)); }
function authorised(req, u) {
    const t = req.headers['x-foo-token'] || u.searchParams.get('t') || '';
    return t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
}
const ROUTES = { '/api/play': () => play(), '/api/stop': () => stop('stopped from the phone'),
    '/api/show': () => show(), '/api/hide': () => { hide('hidden from the phone'); return null; } };
const web = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (!authorised(req, u)) return send(res, 403, 'text/plain', 'Scan the QR code on the iDrive Foo page.\n');
    if (!settings.enabled) return send(res, 503, 'text/plain', 'Foo is off: turn it on on the iDrive Foo page.\n');
    if (req.method === 'GET' && u.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', PAGE);
    if (req.method === 'GET' && u.pathname === '/api/status') return json(res, 200, status());
    if (req.method !== 'POST' || !ROUTES[u.pathname]) return json(res, 404, { error: 'not found' });
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 16384) req.destroy(); });
    req.on('end', () => {
        let e;
        try { e = ROUTES[u.pathname](b ? JSON.parse(b) : {}); } catch (x) { e = x.message; }
        if (control) control.broadcast();
        json(res, e ? 400 : 200, e ? { error: e, status: status() } : status());
    });
});

/* ---- on / off, the app's commands ---- */
function addFirewall() { if (!NO_FIREWALL) try { firewall.add(PORT, IFNAME); } catch (e) { log('firewall: ' + e.message); } }
function removeFirewall() { if (!NO_FIREWALL) try { firewall.remove(); } catch (e) { log('firewall: ' + e.message); } }
function setEnabled(on) {
    if (settings.enabled === on) return;
    settings.enabled = on;
    saveSettings();
    if (on) addFirewall(); else { stop('Foo was turned off'); removeFirewall(); }
}
let control = null;
function command(c) {
    if (c.cmd === 'speed') { setSpeed(c.kmh); return null; }
    if (c.cmd === 'enable') { setEnabled(true); return null; }
    if (c.cmd === 'disable') { setEnabled(false); return null; }
    if (!settings.enabled) return 'Foo is off';
    if (c.cmd === 'play') return play();
    if (c.cmd === 'stop') return stop('stopped on the iDrive page');
    if (c.cmd === 'show') return show();
    if (c.cmd === 'hide') { hide('hidden on the iDrive page'); return null; }
    return 'unknown command';
}

/* ---- start and stop ---- */
let stopping = false;
function shutdown(sig) {
    if (stopping) return;
    stopping = true;
    log('stopping (' + sig + ')');
    stop('the tool stops');
    removeFirewall();
    if (control) control.close();
    web.close();
    setTimeout(() => process.exit(0), 200);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (settings.enabled) addFirewall();
web.listen(PORT, '0.0.0.0', () => log('web: listening on port ' + PORT));
control = startControl({ app: 'vizualyse_foo', status: status, command: command, log: log });
```

Node 8.16 is the runtime: no optional chaining, no `??`, no
`fs.rmSync`, no `Array.prototype.flat`; `URL` is global, async/await works.
CI runs `node -c` on every shipped file in Node 8 (section 8).

### 5.4 The control socket

`control.js` (copy Steam's, change the socket path, the environment
variable and the header comment) gives you:

- a Unix stream socket at `/dev/shm/vizualyse-foo/ctl.sock`, **mode 0660 in
  your app's own group**: it finds your app under `/var/opt/public/oap/oap_<uid>/source/package.json`
  by its package name and uses that folder's group; root only (0600) while
  the app is not installed; looked up again every 10 s (a reinstalled app
  gets a new uid);
- newline-delimited JSON, lines up to 4 KB;
- `{"ev":"status", ...status()}` to every client **on connect, after every
  command and once a second**; `{"ev":"error","error":"..."}` for a command
  that failed. `speed` is answered with nothing (it comes every second and
  the status goes out every second anyway).

The protocol every app here speaks, and Foo should too:

| From the app | Meaning |
|---|---|
| `{"cmd":"enable"}` / `{"cmd":"disable"}` | the tool on or off (kept) |
| `{"cmd":"show"}` / `{"cmd":"hide"}` | the picture on the central screen or not |
| `{"cmd":"speed","kmh":N}` | the car's speed, once a second |
| your verbs: `{"cmd":"play"}`, `{"cmd":"stop"}`, ... | with their arguments as fields |

Keep the app dumb: it sends verbs and renders `status`. Every decision (may
it show, is it moving, what the status line says) is the tool's, so the
phone page and the iDrive page always agree.

### 5.5 Drawing on the central screen

mgu-render shows an app's pictures from a **frame file** and a draw op
([central-screen.md](../knowledge/central-screen.md)):

- **The frame file** `/dev/shm/mgu-video-vizualyse_foo`: a 64-byte header of
  u32 LE words (0 `MGVF`, 1 version 1, 2-3 width height (even, 16..2048),
  4 seq, 5 slot, 6 nslot, 7 matrix 0 BT.601 / 1 BT.709, 8 range 0 limited / 1
  full), then `nslot` I420 frames with no padding. The writer fills slot
  `(slot+1) % nslot`, then sets `slot`, then `seq + 1`. Owned by root, the
  app's uid or `nobody`. Make it black (Y 0, U and V 128), not zeros, or it
  shows green until the first picture.
- **A writer**: from C, the platform's `native/frame_out.{c,h}` (Moonlight's
  decoder, Browser's and Steam's compositors use it); from Node, write the
  slots yourself (Cast's [`console_out.js`](../native/vizualyse-cast/src/console_out.js)).
- **The layer**: an mgu-render client in `layer` mode, placed in the **app
  area, 1790x638 at +108+82** of the 1920x720 screen. That leaves the HMI's
  title bar and its left strip (with the back arrow) uncovered, so the
  driver can always leave. Steam's [`screen.js`](../native/vizualyse-steam/src/screen.js)
  is the one to copy: `frameFile(w, h)`, then `new Screen(log).show({x, y, w, h})`
  connects, places, names the video, `fps(0)`, shows, and sends the VIDEO op
  once a second (three seconds of silence and mgu-render hides you).
  `hide()` undoes it.
- mgu-render fits the picture to the area, aspect kept: draw at the size you
  can afford (Browser's resolution setting draws at 1/2, 1/3, 1/4 and lets
  mgu-render scale up).
- The renderer hides layer apps while the reversing camera shows; nothing
  to do.

Touches still reach the HMI under your picture. Section 6.4 says how the app
makes sure there is nothing under it to press.

### 5.6 The cluster and the HUD

cluster-render takes layers on three targets: `map` (cluster centre,
1088x480), `panel` (the whole cluster, 1920x720) and `hud` (800x480)
([cluster-and-hud.md](../knowledge/cluster-and-hud.md)). Use the platform's
`tool/cluster_render_client.js` (MPL-2.0, Robert Nisipeanu's):

```js
const { ClusterRender } = require('./cluster_render_client.js');
const cr = new ClusterRender('vizualyse_foo');
cr.on('layer', (ref, state, reason) => log('render: layer ' + ref + ' ' + state + (reason ? ': ' + reason : '')));
cr.connect();
// Moonlight's map output: 640x360 frames at 15 fps, placed in the 1088x480 target
const r = placement(OUTPUTS.map);           // Moonlight's: where in the target, aspect kept
const layer = cr.video({ target: 'map', z: 1, contend: true, prewarm: true,
    x: r.x, y: r.y, w: r.w, h: r.h, vw: 640, vh: 360, fps: 15 });
cr.frame(layer, atlas(i420, 640, 360, out), ++frameNo);   // Moonlight's atlas()
```

- Video width a **multiple of 4**, height even, or the layer is refused.
- The link has a **5500 KB/s** ceiling shared by everyone: Cast sends
  512x288 and Moonlight 640x360 at 15 fps to the map, both 480x270 to the
  HUD; let the renderer scale up.
- `contend: true` takes the slot from the cluster's own content and
  `prewarm` asks for it before the first frame (see the take-over warning
  below before using either).
- The cluster draws its own direction list, media widget and pop-ups over
  you; the HUD's top is clipped and its speed sits at the bottom (use 25-65 %
  of the height, 17-83 % of the width); **black is transparent on the HUD**.
- **Take-over (`contend`) is risky**: pressing BC while our layer held the
  centre broke the cluster until a full car restart. Prefer running when
  the slot is free (navigation on, or the central display area off).

Copy the placement and atlas code from Moonlight's
[`server.js`](../native/vizualyse-moonlight/src/server.js) (`atlas()`,
`placement()`, its `OUTPUTS`).

### 5.7 Sound

Everything plays into a SmartXbar input; `CarPlayMain_CF_48_STEREO` reaches
the speakers while CarPlay (or nothing else) is the source
([sound.md](../knowledge/sound.md)). Use the platform's `tool/pcm_play.py`
(mgu-python 3.12, libasound through ctypes, nothing to compile):

```js
const PYTHON = process.env.FOO_PYTHON || '/var/opt/mgu-python/current/bin/python3';
const py = spawn(PYTHON, [path.join(__dirname, 'pcm_play.py'), '--file', '-', '--live'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
source.pipe(py.stdin);          // S16LE, 48 kHz, stereo
```

- `--live` for anything that must stay in step with a picture: it keeps the
  device 60 ms full and drops what waits longer (SmartXbar's first connect
  after boot can block for 50 s). Without it every sample plays, late.
- It makes the SmartX stream's lock as the system does before opening it.
  Never open a SmartX device as root any other way.
- Stopping: SIGTERM, then SIGKILL after a second (it can sit in a blocking
  ALSA write). Check no player of yours outlives the test.
- Volume: scale the samples yourself (Moonlight's `setVolume`).


### 5.8 The internet

Root has no internet. Do network work as your uid (`"internet": true`,
`"uids": [12995]`), and resolve names through the phone's DNS:

- Cast and Browser run a small HTTP / CONNECT **proxy** as the uid
  ([`proxy.js`](../native/vizualyse-chromium/src/proxy.js)) on 127.0.0.1 and
  point their programs at it (`http_proxy`, `--proxy-server`).
- Steam writes the phone's DNS servers to a file its bundled libc reads.
- Moonlight talks to a PC on the hotspot as its uid too (root has no route
  there either).

If you need nothing from the internet, leave `internet` and `uids` out.

### 5.9 Input

- **Touch**: the platform's `native/touch.{c,h}` decodes the display's
  touch PDUs, read passively from vlan73 (AF_PACKET); Browser's
  [`sink/touch_main.c`](../native/vizualyse-chromium/sink/touch_main.c)
  prints them as JSON lines for a Node tool. Map screen coordinates into
  your area; touches outside it are the HMI's.
- **Game controllers**: no HID or evdev in the kernel; wired XInput pads
  through usbfs (Moonlight's `core/pads.c`).
- **The iDrive controller and BACK / HOME** only reach RHMI states, not your
  layer ([input.md](../knowledge/input.md)).

### 5.10 Memory and CPU

The unit has about 5.6 GB for everything, the HMI included. Anything big
runs in a **cgroup v1 memory group** with a cap (Browser 1.5 GB by default,
Steam 2.5 GB), so the kernel kills your process, never the HMI's; read
`memory.oom_control` and say so in the status (Browser's and Steam's
`cgroup()`, `watchMemory()`). Run children at nice 0 or above; CarPlay's
audio threads must never starve.

### 5.11 Native code

- **Linked against the unit's glibc 2.27**: build in Ubuntu 18.04 (gcc 8)
  with `-Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2`; check the result
  needs no newer `GLIBC_` symbol and only libraries the unit has
  (Moonlight's [`build.sh`](../native/vizualyse-moonlight/build.sh) refuses
  otherwise).
- **Or bundle your own userland** (Browser, Steam): glibc, its loader and
  every library, the executables pointed at the bundle's loader by absolute
  path, `LD_LIBRARY_PATH` only on their own exec.
- **Reproducible**: fixed image tags, fixed paths, sorted and dated tars.
  `release.js check` builds twice and compares bytes.
- **GPU**: only the unit's own Mesa 19 (`/usr/lib/libEGL.so.1`, `i965`),
  the render node `/dev/dri/renderD128` in group `video` (44), never
  `/dev/dri/card0` (the display, Winston's). A new GPU path is on by hand,
  never kept across a start, with a marker in `state/` that says a try was
  running ([browser.md](../knowledge/browser.md)).
- `build.sh` starts with the platform sync line (section 7), mounts the tool
  folder at `/m` in Docker, writes to `build/` (ignored by git), and skips
  the work when a hash of its inputs hasn't changed.

### 5.12 The phone page

`page.html` is one self-contained file (inline CSS and JS, no CDN: the
phone may be offline apart from the car). It reads the token from
`location.search`, polls `GET /api/status?t=...` about once a second, and
posts to `/api/<verb>` with the token in a header. Copy Steam's
[`page.html`](../native/vizualyse-steam/src/page.html) and keep its layout.

## 6. The iDrive app

### 6.1 The staged tree

`apps/vizualyse_foo/vizualyse_foo@0.1.0/` is the OAP package without its
code. The folder name carries the version; `release.js bump` renames it.

**package.json**:

```json
{
  "name": "vizualyse_foo",
  "version": "0.1.0",
  "description": "Foo: what the app does, one sentence",
  "private": false,
  "main": "javascript/runner.js",
  "oapAppSettings": {
    "maxDiskUsage": 26214400,
    "cpuLimit": 50,
    "memoryThresholdKB": 153600,
    "priority": "PRIO_MEDIUM",
    "visibility": "FOREGROUND",
    "latencyClass": "FOREGROUND",
    "loggingId": "VFOO",
    "userLoginRequired": false,
    "backgroundPriority": 150,
    "someipManifest": "manifest.json"
  },
  "files": ["config", "rhmiData", "package.json", "npm-shrinkwrap.json", "permissions.json",
            "javascript", "manifest.json", "CHANGELOG.md", "LICENSE"],
  "dependencies": { "oap-sdk": "24.10.2" },
  "engines": { "node": ">=8.7.0" },
  "author": "Your name",
  "license": "GPL-3.0-or-later",
  "mguLocalOnly": true
}
```

- `mguLocalOnly: true` is required (the deploy tool refuses an app without it).
- Every name in `files` must exist in the package, or the unit's build refuses it.
- `loggingId`: four letters, your own (DLT).
- `memoryThresholdKB`, `cpuLimit`: MainApp kills an app over them, and a
  killed app is wiped, then uninstalled. Keep the app small.

**manifest.json**: the SOME/IP proxies the app may use. Copy Steam's; it
already has `Vehicle2` with `statusCarSpeed2` readable. Add only what you
need; the installer refuses a read flag on a field the firmware has no
getter for (check `/etc/oap/someip/someip-interfaces.json`).

**permissions.json**: copy it as is (identical in all four apps).

**npm-shrinkwrap.json**: `{"name", "version", "lockfileVersion": 1, "requires": true, "dependencies": {}}`.

**config/base.json**: `{}`.

**rhmiData/application.json**: the app and its tile. **Every UUID must be
new** (`node -e "console.log(require('crypto').randomUUID())"`, four of
them): `application.uuid`, `stringBundleUuid`, `resourceBundleUuid`,
`entryPoints[0].uuid`. Two apps with one UUID collide in the HMI. Steam's
page test asserts its UUIDs are not Browser's (the app it was copied from);
point that check at the app you copied.

```json
{
  "schemaVersion": "1.3.0",
  "application": {
    "uuid": "<new>",
    "type": "OnlineApp",
    "name": "vizualyse_foo",
    "vendor": "Your name",
    "version": "0.1.0",
    "defaultLanguage": "en_GB",
    "uiDescriptions": [{ "applicationFilePath": "./uiDescriptions/ID7/application.xml",
      "uiDescriptionFilePath": "./uiDescriptions/ID7/uiDescription.json", "hmi": ["ID7"] }],
    "stringBundleUuid": "<new>",
    "resourceBundleUuid": "<new>",
    "variantGroups": [{ "stringsPath": "./variantGroups/Common/texts",
      "resourcesPath": "./variantGroups/Common/images", "hmi": ["ID7"], "brands": ["BMW"] }],
    "entryPoints": [{
      "name": "vizualyse_foo", "uuid": "<new>", "textId": "SID_FOO_TITLE",
      "icon": "vizualyse_foo_icon.png",
      "insertionStateId": 20974, "insertionFocusId": 2, "insertionMode": "INSERT_BELOW",
      "insertionOrder": 1, "insertionPriority": 0, "previewType": "NONE", "bookmarkable": true,
      "private": null, "appearance": "DEFAULT", "isGroupHeader": false, "insertionGroup": 0
    }]
  }
}
```

**texts/en_GB.json**: `{"SID_FOO_TITLE": "Foo"}`, the tile's name and the
page title. The Store's title comes from it too (`release.js appTitle`).

**images/vizualyse_foo_icon.png**: 140x140, white on transparency, drawn by
`tools/make_icon.js` (a function `inside(x, y)` supersampled 4x).

**CHANGELOG.md**: a `## 0.1.0` entry; every bump adds one.

### 6.2 The page

The page is two generated files, `application.xml` (the layout) and
`uiDescription.json` (names, properties, first texts). They must agree, so
**`tools/make_page.js` writes both from one list**; never edit them by hand.

```js
/* [id, type, widget, name, focusable, first text] */
const C = [
    [20, 'label',  'LT_Label_1Row',              'fooStatus', 0, 'Connecting...'],
    [30, 'button', 'LT_Button_1Row',             'fooPlay',   3, 'Play'],
    [31, 'button', 'LT_Button_1Row',             'fooStop',   3, 'Stop'],
    [32, 'button', 'LT_Button_1Row',             'fooShow',   3, 'Show on the screen'],
    [21, 'label',  'LT_Label_1Graphic_Scalable', 'fooQr',     0, null],
    [22, 'label',  'LT_Label_1Row',              'fooLink',   0, ''],
    [23, 'label',  'LT_Label_1Row',              'fooHint',   0, ''],
    [37, 'button', 'LT_Button_1Row',             'fooEnable', 3, 'Foo: on'],
];
```

```sh
node apps/vizualyse_foo/tools/make_page.js apps/vizualyse_foo/vizualyse_foo@0.1.0
```

What the generator writes (Steam's, renamed):

- **State 1**, `ST_OnlineApps_VizualyseFoo`, widget `LT_State_Wide`: a title
  (component 10, the string `SID_FOO_TITLE`) and the list in your order.
  Ids share one space across the whole page; containers 1-9, titles 10-19,
  rows from 20.
- **State 2**, `ST_OnlineApps_VizualyseFooScreen`, property 9 (ParentState)
  = 1: a title and one label, **nothing focusable**. The app opens it while
  your picture covers the app area (6.4). Leave it out if you never draw on
  the central screen.

Widgets proven on cars: `LT_Label_1Row`, `LT_Button_1Row`,
`LT_Label_1Graphic_Scalable` (an image), `LT_CheckBox_1Row`,
`LT_Button_2Row_2Text`, `LT_Button_1Row_2Col7030_2Text` (a "Setting | value"
row), a drop-down (`dropDownMenu`). Property ids: 1 Enabled, 2 Visible, 3
Focusable (0 static, 3 focusable and clickable: buttons need 3), 9
ParentState. More, and how to build a drop-down or a pick list:
[idrive-app-ui.md](../knowledge/idrive-app-ui.md).

**Texts are ASCII**, one row, at most about 90 characters: RHMI Text is not
a reliable Unicode transport on this firmware. The tool sends what the app
shows; make it ASCII on the app side too (Steam's `ascii()`).

### 6.3 mgu-app.json and the source package

```json
{
  "schema": 1,
  "id": "vizualyse_foo",
  "version": "0.1.0",
  "tree": "vizualyse_foo@0.1.0",
  "modules": [
    "src/vizualyse_foo.js",
    "src/foo_control.js",
    "src/vehicle_speed.js",
    "src/qr_png.js",
    "src/qrcode.js"
  ],
  "sdk": [
    "oap-sdk/src/core/OnlineApp.js",
    "oap-sdk/src/logging/logging",
    "oap-sdk/src/someip/someipBuilders"
  ]
}
```

- `modules`: the entry first. The app's modules **require each other as
  `./<file name>`** and are bundled flat (`tools/oap_link.js`), so two modules
  can't share a name and there are no subfolders.
- `sdk`: every `oap-sdk` path the code requires. The repository carries no
  oap-sdk: **the head unit links the app against its own SDK** when it
  installs the source package (`"build": "unit"` in the catalog).
- Platform copies (`qr_png.js`, `qrcode.js`, `vehicle_speed.js`) are listed
  like your own modules; they exist once `sync` has run (section 7).

`tools/build.js` syncs, then packs `vizualyse_foo@0.1.0.src.tgz`:
`mgu-app.json`, the modules, the staged tree. With `--sdk <donor>` (a bundle
from the unit: `mgu-deploy.sh sdk-donor`) it also builds the OAP tgz the
unit would build, to check the link off the car.

### 6.4 The app's code

The entry module subclasses the SDK's `OnlineApp`. Its life, as Steam's
[`vizualyse_steam.js`](../apps/vizualyse_steam/src/vizualyse_steam.js) does it:

```
start()
 └ 'initialized'
    ├ no rhmiApplication (a background start)  ->  initialized(), nothing else
    ├ open the control socket; start the speed reader (whatever the page)
    ├ _setupRhmi: getByName each component; bind buttons; watch events;
    │             state.updateResources(); render
    ├ _registerEntryPoints: init the tile; mapEntryState(tile, main state);
    │                       setText / setIcon; setAvailability('ENABLED')
    ├ registerActive() if started in the foreground (else MainApp stops it)
    ├ initialized()      (MainApp shows "loading app" until this)
    └ open the last executed entry point, if any
 'entryPointExecute' -> openEntryState(uuid)
 'shutdown'          -> hide, close the socket, release the QR handle, destroyBundles(), exit(0)
```

The parts worth copying as they are:

- **Buttons**: `comp.on('action', ...)` and the raw `rhmi.on('userEvent')`
  (`eventType === 'ACTION'`, `sourceId` = the component id) can both fire
  for one press: **dedupe within 400 ms** (`_press`).
- **Rendering**: one `_render()` that writes every row from the tool's
  status, through a cache (`_write`, `_setEnabled`, `_show`), so only
  changes go to the HMI. Call it on every status change and on
  `restoreHmi` (with the cache cleared: the HMI lost everything).
- **The QR code**: a PNG of the link (platform `qr_png.js`, 360 px) in a
  world-readable folder in `/dev/shm`, **a new file name for each new
  link** (the HMI doesn't load a path again), `createResourceHandles`, then
  `setValue(0, 'Graphic', file, 'ResourceId')`, `flush()`, then destroy the
  old handle and delete the old file.
- **Visibility**: `applicationStackChanged` with `ROOT_APP` = in front; each
  state's `visible` and `focus` events. **`focus: false` while still visible
  is a pop-up, a call or a warning**: wait 300 ms to tell it from leaving.
  Report `registerActive` / `registerHmiVisible` when shown and the reverse
  when hidden.
- **Showing a picture over the app area** (Browser, Steam): the HMI still
  gets every touch under it. So `Show` first `openState`s the screen state
  (nothing to press on it) and sends `show` only once that state is
  `visible`; meanwhile every button of the main page is disabled. If the
  screen state isn't visible within 3 s, the picture goes over the main page
  (buttons disabled) and the log says why. **Hide** whenever the state it
  is shown over loses visibility or focus (BACK, HOME, another app, a
  pop-up), when the app hides, and at shutdown. The picture keeps running
  hidden; the tool decides what that means.
- **The speed**: the platform's `vehicle_speed.js`:

  ```js
  const { watchSpeed } = require('./vehicle_speed.js');
  const builders = require('oap-sdk/src/someip/someipBuilders');
  this._stopSpeed = watchSpeed(builders, logger, (kmh) => this._control.speed(kmh));
  ```

  It polls `Vehicle2.statusCarSpeed2` every second (a standing car may
  never notify) and calls back only with valid readings. Start it for the
  app's whole life, not just while the page shows.
- **Never crash**: catch every promise; on a failed start log and stay
  resident (`app.start().catch(...)` at the bottom).

### 6.5 The app's end of the socket

`foo_control.js`, copied from Steam's `steam_control.js`:

- connects to `/dev/shm/vizualyse-foo/ctl.sock` (`FOO_CTL_SOCKET`
  overrides it for tests), retries every second while wanted;
- keeps the last `status` and the last `error` (shown on the status line for
  10 s), emits `change`;
- one method per verb (`play()`, `stop()`, `show()`, `speed(kmh)`...),
  returning `false` when not connected;
- `statusText()` turns the status into the status row: not running, off,
  moving ("Only while parked - the car is moving (30 km/h)"), an error,
  what is playing.

## 7. The platform in your app

The platform holds the code the apps share as modules, each versioned on its
own ([README.md](README.md)). For each module you use you pin a version and
say which of its files you copy and where; `sync` writes the copies where
your code and build already look. They are never committed. Modules mix
freely: `common/qrcode` 1.0.0 beside `native/touch` 1.0.1.

**In the tool's `component.json`** (and list each copy in `files[]` as usual):

```json
"platform": {
  "common/qrcode": { "version": "1.0.0", "files": { "src/qrcode.js": "qrcode.js" } },
  "native/frame_out": { "version": "1.0.0", "files": { "core/frame_out.c": "frame_out.c", "core/frame_out.h": "frame_out.h" } },
  "tool/cluster_render_client": { "version": "1.0.0", "files": { "src/cluster_render_client.js": "cluster_render_client.js" } },
  "tool/pcm_play": { "version": "1.0.0", "files": { "src/pcm_play.py": "pcm_play.py" } }
}
```

**In the app's `release.json`** (and list each copy in `mgu-app.json` `modules`):

```json
{
  "build": "node tools/build.js",
  "requires": { "vizualyse-foo": "0.1.0" },
  "uninstallable": true,
  "mguHmi": ["ID7"],
  "platform": {
    "app/qr_png": { "version": "1.0.0", "files": { "src/qr_png.js": "qr_png.js" } },
    "app/vehicle_speed": { "version": "1.0.0", "files": { "src/vehicle_speed.js": "vehicle_speed.js" } },
    "common/qrcode": { "version": "1.0.0", "files": { "src/qrcode.js": "qrcode.js" } }
  }
}
```

Then:

```sh
node platform/platform.js sync apps/vizualyse_foo native/vizualyse-foo
git add apps/vizualyse_foo/src/.gitignore native/vizualyse-foo/src/.gitignore
node platform/platform.js check
```

The modules (`node platform/platform.js list` for their versions):

| Module | Files | What it is |
|---|---|---|
| `tool/pcm_play` | `pcm_play.py` | PCM into SmartXbar, `--live`, the lock made right (5.7) |
| `tool/cluster_render_client` | `cluster_render_client.js` | cluster-render's Node 8 client, MPL-2.0 (5.6) |
| `common/qrcode` | `qrcode.js` | Kazuhiko Arase's QR generator, MIT (both sides) |
| `app/qr_png` | `qr_png.js` | `qrPng(text, maxPx)`, `png(w, h, rgba)` |
| `app/vehicle_speed` | `vehicle_speed.js` | `watchSpeed(builders, logger, onSpeed)` (6.4) |
| `native/frame_out` | `frame_out.{c,h}` | the mgu-render frame-file writer (5.5) |
| `native/touch` | `touch.{c,h}` | the iDrive 7 touch PDU decoder and hold-to-stop (5.9; Moonlight, Browser, Steam) |
| `native/wayland_drm` | `wayland-drm.xml` | Mesa's `wl_drm` protocol, for a Wayland compositor |
| `native/pads` | `pads.{c,h}`, `pad_flags.h`, `test/pads_test.c` | gamepad reports to XInput's buttons and sticks (Moonlight's mapping; Steam) |
| `native/usb_pads` | `usb_pads.{c,h}` | XInput USB pads found, claimed and read through usbfs, player LEDs (needs `native/pads`) |
| `native/usbip_pad` | `usbip_pad.c` | a virtual XInput USB pad through vhci_hcd, for off-car tests |

Still **copied per app** (moving into modules of their own, `TODO.md`):
the tool's `control.js`, `firewall.js`, `proxy.js`, `screen.js` /
`console_out.js`, `unpack.js`; the app's `*_control.js`, `tools/build.js`,
`make_page.js`, `test_page.js`. Copy them from Steam and rename. When one of
them reaches the platform, move your app onto it with a pin instead of
fixing your copy.

A **fix to a platform file** is a new version of its module, never an edit
to your copy (`check` refuses a copy that differs). `platform.js use
<module> <version>` moves every component using it, or the ones you name,
and bumps them.

Every script that reads the copies syncs first; add the same line to yours:

```sh
# a tool's build.sh or test runner, after HERE / WIN_HERE
node "$WIN_HERE/../../platform/platform.js" sync "$WIN_HERE" >&2
```

```js
// an app's tools/test_page.js, after ROOT; build.js and make_icon.js the same
require(path.join(ROOT, '..', '..', 'platform', 'platform.js')).sync(ROOT);
```

## 8. Testing off the car

Most of the work can be proven before anything reaches the unit. What each
layer of test is for:

| Test | What it proves | How |
|---|---|---|
| **The page** `apps/vizualyse_foo/tools/test_page.js` | the app against a fake SDK, a fake HMI built from your own `uiDescription.json`, and a fake tool socket with a scripted status | `node apps/vizualyse_foo/tools/test_page.js` |
| **The control socket's group** | only your app can connect; root only without it; a reinstall's new uid works | `node native/vizualyse-cast/test/control_test.js native/vizualyse-foo/src/control.js vizualyse_foo` as root in Linux (CI's step) |
| **Node 8 syntax** | every shipped `.js` parses on the unit's Node | CI's `node:8.16.2-alpine` loop |
| **The tool in the unit's rootfs** | `server.js` end to end on glibc 2.27, Node 8.16, Mesa 19, no network | Browser's [`test/run_unit_test.sh`](../native/vizualyse-chromium/test/run_unit_test.sh): `../idrive-rootfs/20.40.2/rootfs.tar` imported as `idrive-rootfs:I_21w12.2-1-4` |
| **The GPU** | your GL code on the unit's own i965 driver (no pixels) or llvmpipe (pixels) | [`tools/gpu-bench`](../tools/gpu-bench/README.md) `stub` / `swrast` |
| **Reproducible build** | one version, one artifact | `node release/release.js check vizualyse-foo vizualyse_foo` (Linux) |

**The page test**, copied from Steam's and renamed, is the most valuable
one. Keep its structure:

- check `application.xml` and `uiDescription.json` agree, every button is
  bound, and the UUIDs are not another app's;
- load the app's real modules with `Module._load` patched so
  `oap-sdk/...` names resolve to fakes (`OnlineApp`, the logger,
  `someipBuilders` with a settable speed);
- run a fake tool socket that sends `status` objects you script, and
  records what the app sends;
- then walk the behaviour: no tool (status says so, buttons off), connected
  (QR PNG written, link shown), each button sends its verb, Show opens the
  screen state and sends `show` when it is visible, BACK and a pop-up hide,
  a failed command's error on the status line, the speed reaches the tool,
  "only while parked", on / off, the tool going away.

The tool's own test (Browser's [`test/server_test.js`](../native/vizualyse-chromium/test/server_test.js),
Moonlight's) runs `server.js` as a child with every path moved into a temp
folder by environment variables (`FOO_PORT`, `FOO_STATE`, `FOO_CTL_SOCKET`,
`FOO_NO_FIREWALL=1`...) and stand-ins for mgu-render
([`test/fake/render_client.js`](../native/vizualyse-chromium/test/fake/render_client.js))
and the speakers. That is why every constant in 5.3 reads an environment
variable.

**Add your tests to CI** (`.github/workflows/test.yml`): a step for the page
test, your `src/*.js` in the Node 8 loop, your `control.js` in the control
socket step, your tool's own test if it can run on GitHub's runner.

Some things only the car can tell: the GPU and kernel (a hang), real frame
rates on the Atom, the cluster's behaviour, SmartXbar's routing, the HMI's
real event order. Write those down in your README's "On the car, still to
find out".

## 9. Releasing

- **Versions**: one version, one artifact. Builds run from `git archive
  HEAD` with `SOURCE_DATE_EPOCH` from the last commit that touched what the
  component ships, the platform files it copies included. Any change to
  that needs a bump:

  ```sh
  node release/release.js bump vizualyse-foo 0.1.1
  node release/release.js bump vizualyse_foo 0.1.1    # renames the staged tree, edits package.json etc.
  ```

  then a `## 0.1.1` entry in the app's `CHANGELOG.md`, and raise the app's
  `requires` if it needs the new tool.
- **Check**: `node release/release.js list` (versions and what is published),
  `node release/release.js check` (two builds, compared; run it on Linux:
  `exportHead` fails on Windows' tar).
- **Publish**: the Release workflow (Actions > Release, the component ids),
  from `main` only. It builds, uploads `<id>@<version>.tgz` as a GitHub
  release and publishes `catalog.json`. A version already published with
  other bytes is skipped: bump it.
- **Install**: in the Store, the source `Vizualyse/idrive-apps`, channel
  Releases; installing the app installs the tool first (`requires`), and the
  tool's own requirements from their sources.

## 10. On the car

**Ask before anything live on the unit.** Read-only first:

```sh
journalctl -u vizualyse-foo --no-pager | tail -100
cat /var/opt/vizualyse-foo/state/settings.json
ls -la /dev/shm/vizualyse-foo/ /dev/shm/mgu-video-vizualyse_foo
nft -a list chain ip filter input | grep vizualyse-foo
ls -la /run/smartx/                          # after sound: every lock ent_alsa:mgu_alsa
dmesg | grep -iE 'i915|blocked for more'     # after GPU work: must be empty
```

- The journal holds minutes: read it right after the try, and keep what you
  need in `state/`.
- **Don't poll the unit while a stream runs** (`node -e`, journal loops):
  it changes what you measure. Read the logged stats afterwards.
- **Never** `systemctl stop` a unit that isn't on recmgr's whitelist at
  this boot, restart `hmi.service`, or kill a renderer with surfaces up.
  To restart the tool: `systemctl restart vizualyse-foo` (it is listed),
  or turn it off and on from its page.
- The SSH host key changes at every boot (the debug image).
- After a test, check nothing of yours is still playing or holding a device.

## 11. Checklist

Numbers and names:

- [ ] tool id, app id (`vizualyse_`), port, uid, socket and frame-file paths are new (section 3)
- [ ] five new UUIDs in `application.json`; a new `loggingId`; a new `SID_*_TITLE`

The tool:

- [ ] `component.json`: `requires`, `recmgr`, `crashNames` for every program, `deactivate` removes the firewall rule, `internet` + `uids` only if needed, `platform` pin
- [ ] the unit: `StandardOutput=journal`, `LimitCORE=1`, `Restart=always`
- [ ] the phone page needs the token; off answers 503
- [ ] the control socket is in the app's own group
- [ ] nothing shows above 3 km/h; moving hides
- [ ] the picture stays inside the app area (1790x638 at +108+82)
- [ ] sound through the platform's `pcm_play.py`
- [ ] network work as the tool's uid, names through the phone's DNS
- [ ] big processes in a memory cgroup; risky modes on by hand, never kept, with a state marker
- [ ] native code: glibc 2.27, the unit's loader, reproducible, platform sync in `build.sh`

The app:

- [ ] `package.json`: `mguLocalOnly`, `files` all present
- [ ] `manifest.json` has `Vehicle2` / `statusCarSpeed2`
- [ ] page generated by `make_page.js`; buttons focusable 3; texts ASCII, one row
- [ ] presses deduped; every promise caught; stays resident on a failed start
- [ ] hides on BACK, HOME, a pop-up, another app, shutdown
- [ ] the speed goes to the tool for the app's whole life
- [ ] `release.json`: `requires` the tool, `platform` pin; the copies in `mgu-app.json` `modules`

Tests and docs:

- [ ] `test_page.js` passes; control socket test; Node 8 syntax; all three in CI
- [ ] `node platform/platform.js check` and `release.js check` pass
- [ ] READMEs for both, `THIRD-PARTY.md` for what the kit carries, the root README's table, `TODO.md`
