# vizualyse_moonlight

The iDrive 7 app for [vizualyse-moonlight](../../native/vizualyse-moonlight)
(Moonlight), which streams games from a PC running
[Sunshine](https://github.com/LizardByte/Sunshine) to the central screen.
Pairing, the host and the game are picked on the phone page the tool serves.
The tile is **Moonlight**.

## The page

One `LT_State_Wide` page:

| Row | What it does |
|---|---|
| status | `Ready — scan the QR code to pair and pick a game`, `Starting Forza Horizon 5 from GAMING-PC…`, `Streaming Forza Horizon 5 from GAMING-PC — 20 s`, `Ended: …`, `Waiting for the phone's hotspot`, `Error: …` (the stream's, or a failed command's for 10 s), `The Moonlight tool is not running — install Moonlight (the tool) from the Store` |
| QR code | the phone page's link, an `LT_Label_1Graphic_Scalable` showing a PNG from `/dev/shm/vizualyse_moonlight_qr_<uid>/` |
| link | the same link as text, and how to use it |
| Moonlight: on / off | the whole service (`enable` / `disable`) |
| Stop | stops streaming; the game keeps running on the PC; enabled while a stream starts or plays |
| Quit game | stops streaming and closes the game on the PC; enabled while a stream starts or plays |
| Resume last | starts the last host and game again; enabled while nothing streams and the tool says `canResume` |
| info | while there is a host: host (address), game, fps, controllers; otherwise the uplink, the renderer, the controllers and the last game |

## The socket

`/dev/shm/vizualyse-moonlight/ctl.sock` (`MOONLIGHT_CTL_SOCKET` overrides
it), a Unix stream socket, newline-delimited JSON. The tool sends
`{"ev":"status", enabled, link, uplink, render, state, host, app, frames,
fps, seconds, pads, canResume, last, error, note}` on connect, after each
command and once a second, and `{"ev":"error","error":…}` for a failed
command; the app sends `{"cmd":"enable"}`, `{"cmd":"disable"}`,
`{"cmd":"stop"}`, `{"cmd":"quit"}` and `{"cmd":"resume"}`. The app holds
it while its page is visible. `tools/make_page.js` writes the page's
application.xml and uiDescription.json from one list.

## Build and test

```sh
node tools/build.js          # the source package; the unit builds the app
node tools/test_page.js      # the page against a fake SDK and HMI and a fake tool socket
node tools/make_page.js vizualyse_moonlight@0.1.0
node tools/make_icon.js vizualyse_moonlight@0.1.0/rhmiData/variantGroups/Common/images/vizualyse_moonlight_icon.png
```

The structure (SDK use, tile, visibility, the QR handles) follows
[vizualyse_cast](../vizualyse_cast).
