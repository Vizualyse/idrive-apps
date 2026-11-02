# vizualyse_cast

The iDrive 7 app for [vizualyse-cast](../../native/vizualyse-cast) (Cast to
cluster), which plays a stream URL from the phone on the cluster map, the
HUD or the media console, with its sound through the speakers. The tile is
**Cast**.

## The page

One `LT_State_Wide` page:

| Row | What it does |
|---|---|
| status | `Ready — scan the QR code with your phone`, `Playing on the cluster map, with sound — 12 s`, `Waiting for the phone's hotspot`, `Error: …`, `Cast service not running — install Cast to cluster in the Store` |
| QR code | the phone page's link (`http://<hotspot address>:8480/?t=<token>`), an `LT_Label_1Graphic_Scalable` showing a PNG from `/dev/shm/vizualyse_cast_qr_<uid>/` |
| link | the same link as text, and how to use it |
| Cast to cluster: on / off | the whole service: off stops what plays, hides the QR code and closes the phone page; kept across restarts |
| Stop | stops the stream; enabled while one plays |
| Mirror Google Maps on the cluster / on the HUD | the central screen (CarPlay with Google Maps) cut into its direction banner, map and readouts: stacked on the cluster map, banner and readouts beside the map on the HUD |
| Play last on the cluster map / the HUD / this screen | plays the last stream the phone started again (its URL stays in the tool); this screen needs mgu-render and is hidden without it |
| QR code on the cluster | the tool's idle QR code on the cluster on or off (off by default: the cluster's navigation list covers it) |
| info | the uplink, the cluster renderer and the last stream (without its query) |

## The socket

`/dev/shm/vizualyse-cast/ctl.sock` (the tool's `control.js`), a Unix stream
socket in group `tm_oap_app`, newline-delimited JSON. The tool sends
`{"ev":"status", state, output, audio, seconds, error, uplink, render, qr,
link, canReplay, outputs, url}` on connect, after each command and once a
second (with `enabled` and `screen`); the app sends `{"cmd":"stop"}`,
`{"cmd":"replay","output":…}`, `{"cmd":"mirror","crop":"gmaps"|"gmapsHud","output":"map"|"hud"}`,
`{"cmd":"enable"}`, `{"cmd":"disable"}` and `{"cmd":"qr","show":…}`. The app
holds it while its page is visible. `tools/make_page.js` writes the page's
application.xml and uiDescription.json from one list.

## Build and test

```sh
node tools/build.js          # the source package; the unit builds the app
node tools/test_page.js      # the page against a fake SDK and HMI and the tool's real control socket
node tools/make_icon.js vizualyse_cast@0.2.0/rhmiData/variantGroups/Common/images/vizualyse_cast_icon.png
```

The structure (SDK use, tile, visibility, the QR handles) follows
robertn_waze_cluster and robertn_store.
