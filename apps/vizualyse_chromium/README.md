# vizualyse_chromium

The iDrive 7 app for [vizualyse-chromium](../../native/vizualyse-chromium)
(Browser): Chromium on the car, with WebGL 2, WebGPU and WebAssembly JSPI,
on the central screen while parked (WebGL on the CPU, or on the car's own
GPU driver in the experimental GPU mode). Addresses and text are
typed on the phone page the tool serves. The tile is **Browser**.

## The page

One `LT_State_Wide` page:

| Row | What it does |
|---|---|
| status | `Ready - Show puts it on the screen; ...`, `On the screen - the back arrow on the left returns here`, `Installing the browser (about a minute, once)...`, `Starting the browser...`, `Only while parked - the car is moving (30 km/h)`, `Out of memory - the page needed more than 1536 MB (phone page: Memory)` (for 2 minutes after the tool reports a kill at the cap), `Off - ...`, `Error: ...` (a failed command's for 10 s, or the tool's), `The Browser tool is not running - ...` |
| QR code | the phone page's link, an `LT_Label_1Graphic_Scalable` showing a PNG from `/dev/shm/vizualyse_chromium_qr_<uid>/` |
| link | the same link as text, and how to use it |
| Show on the screen | opens the empty screen state, then `show`: the browser covers the app area (not the HMI's title bar or left strip); off while shown, moving, or not running |
| Browser: on / off | the whole browser (`enable` / `disable`: Chromium runs or not) |
| GPU mode: off / on | `gpu` (experimental): the tool restarts Chromium with WebGL on the unit's own GPU driver (Mesa 19 GLES), and goes back to the CPU by itself if that fails; never kept over a restart of the tool. On needs the browser running; off works any time |
| Resolution: full / 3/4 / 1/2 | `scale` 1, 0.75, 0.5, round: the tool draws the page with fewer pixels (the same layout) and mgu-render scales it up; the button shows the picture's size. Kept by the tool |
| Home page, Reload, Back | `home`, `reload`, `back` |
| page | the page's title and address |
| GPU | what the tool's probe found, one row: `WebGPU: CPU (SwiftShader) \| WebGL 2: CPU (SwiftShader) \| JSPI: ok`, in the GPU mode `WebGPU: GLES compat | WebGL 2: GLES 3.2, Intel HD Graphics 505 (Broxton)`; or `GPU mode: ...`, what became of it (it didn't start, Chromium exited, the last try never ended because the unit restarted) |

Texts are plain ASCII (RHMI Text is not a reliable Unicode transport on this
firmware: knowledge/idrive-app-ui.md); `test_page.js` checks the page's.

## Hiding, and touches under the browser

The browser is a layer over the HMI, and the HMI still gets every touch on
it (the tool only reads a copy). So **Show** first opens the screen state
(`ST_OnlineApps_VizualyseChromiumScreen`, ParentState the main page: a
title and one label, nothing to press) and sends `show` once that state is
visible; while the browser is up every button of the main page is disabled
too. Should the HMI not open the screen state within 3 s, the browser goes
over the main page (its buttons disabled) and the log says why.

The browser stays up only while the state it went up on is visible and
focused: BACK (the arrow left of the browser) brings the main page back and
hides it, as do HOME, another app, and a pop-up, a call or a warning taking
the focus for 300 ms (a shorter blip is ignored). The app also sends
`hide` as it shuts down.

## Only while parked

As vizualyse_moonlight: the app reads `Vehicle2.statusCarSpeed2` every
second (`src/vehicle_speed.js`) and sends `{"cmd":"speed","kmh":N}`; the
tool hides the browser above 3 km/h and won't show it.

## The socket

`/dev/shm/vizualyse-chromium/ctl.sock` (`CHROMIUM_CTL_SOCKET` overrides it),
a Unix stream socket, newline-delimited JSON, open to this app's group only.
The tool sends `{"ev":"status", enabled, link, uplink, bundle, browser,
shown, url, title, home, gpu, speed, moving, pictures, decodeMs, view,
error}` on connect, after each command and once a second, and
`{"ev":"error","error":...}` for a failed command; the app sends
`enable`, `disable`, `show`, `hide`, `home`, `reload`, `back` and, every
second, `speed`. The app holds it while it runs.

## Build and test

```sh
node tools/build.js          # the source package; the unit builds the app
node tools/test_page.js      # the page against a fake SDK, HMI and Vehicle2, and a fake tool socket
node tools/make_page.js vizualyse_chromium@0.2.2
node tools/make_icon.js vizualyse_chromium@0.2.2/rhmiData/variantGroups/Common/images/vizualyse_chromium_icon.png
```

The structure follows [vizualyse_moonlight](../vizualyse_moonlight).
