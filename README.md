# Cast to cluster

Cast to cluster for the BMW iDrive 7 head unit (MGU): a stream URL from your
phone on the instrument cluster, the HUD or the media console, with its
sound through the speakers; or CarPlay's own cluster map (its second screen,
through hook111) on the cluster or the HUD. Installed from the [mgu Store](https://github.com/robertnisipeanu/mgu-store).

A tech demo, built and tested on a bench head unit.

| Path | |
|---|---|
| [`native/vizualyse-cast`](native/vizualyse-cast) | **Cast to cluster**, the tool: the phone page, a static ffmpeg, the CarPlay second screen (from hook111), the uplink proxy, the cluster and HUD through cluster-render, the media console through mgu-render, sound through SmartXbar |
| [`apps/vizualyse_cast`](apps/vizualyse_cast) | **Cast**, its iDrive app: the phone link and QR code, on/off, Stop, CarPlay map on the cluster or the HUD, Play last on the cluster, the HUD or this screen |
| [`samples`](samples) | cluster-render samples: a CPU gauge and clock, raw video and sound from files |
| [`release`](release) | builds and publishes the Store catalog |
| `tools` | `oap_pack.js`, `oap_link.js`: pack the app |
| [`native/hook111`](native/hook111) | **CarPlay cluster map (stream 111)**, a tool: a hook preloaded into the stock 2020 `carplay` that adds CarPlay's second screen and hands it to Cast to cluster. Experimental |
| [`re`](re) | the off-car reverse engineering and harnesses behind hook111 ([status](re/STATUS.md)) |

What's next: [`TODO.md`](TODO.md). What we learned about the unit: [`Learnings.md`](Learnings.md).

## Install

In the Store, add the GitHub source `Vizualyse/idrive-apps` on the
**Releases** channel and install **Cast**; the Store installs **Cast to
cluster** first. It requires, from their own sources: `mgu-deploy`,
`mgu-python` and `mgu-uplink` (mgu-store) and `cluster-render`
([robertnisipeanu/idrive-apps](https://github.com/robertnisipeanu/idrive-apps));
the media console needs `mgu-render` (mgu-store).

## Build and test

```sh
node apps/vizualyse_cast/tools/test_page.js   # the page against a fake HMI and the tool's real control socket
node release/test/release_test.js
node release/release.js check                 # two clean builds, compared byte for byte
```

Each folder's README has the details; [`release/README.md`](release/README.md)
covers versions, the catalog and publishing.

## Credits

The release tooling (`release/`, `tools/`, `.github/workflows/release.yml`)
and the structure of the iDrive app come from Robert Nisipeanu's
[idrive-apps](https://github.com/robertnisipeanu/idrive-apps) (GPL-3.0-or-later),
where this repository started as a fork. Cast to cluster draws through his
cluster-render, whose client `native/vizualyse-cast/src/cluster_render_client.js`
is copied here.

## License

GPL-3.0-or-later ([`LICENSE`](LICENSE)), unless a file's SPDX header says
otherwise: `cluster_render_client.js` is MPL-2.0
([`LICENSES/MPL-2.0.txt`](LICENSES/MPL-2.0.txt)); `qrcode.js` is Kazuhiko
Arase's QR Code Generator (MIT); the bundled ffmpeg is John Van Sickle's
static build (GPLv3, its licence ships beside it).
