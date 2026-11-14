# Knowledge

What we found out building apps and tools for a BMW iDrive 7 (MGU) head
unit: what the unit is, what works, what does not, and why. Measured on one
unit (head unit software `I_21w12.2-1-4`, CarPlay `20.40.2`) unless a line
says otherwise. Lines marked *(ref: …)* come from other people's repositories
([reference-repos.md](reference-repos.md)) and are not yet checked on ours.

What's next: [`../TODO.md`](../TODO.md). The CarPlay second screen in depth:
[`../re/STATUS.md`](../re/STATUS.md).

| File | About |
|---|---|
| [head-unit.md](head-unit.md) | The unit: hardware, filesystem, journal, **what restarts it** (recmgr, crashhandler, oapcontroller), systemd, groups, firewall, the loader |
| [internet.md](internet.md) | mgu-uplink: the phone's hotspot, listed uids, DNS, CAs |
| [carplay.md](carplay.md) | CarPlay on this firmware, the second screen (hook111), upstream's patched 22.28.3 |
| [cluster-and-hud.md](cluster-and-hud.md) | cluster-render: targets, video layers, the upload budget, overlays, take-over risks, the HUD |
| [central-screen.md](central-screen.md) | mgu-render: the frame file, draw ops, text over video, touch, winston-grabber, Google Maps' layout; **Winston directly** (our own ivi surface: shm and dmabufs as they are) |
| [video-decoding.md](video-decoding.md) | ffmpeg on the unit, the cluster atlas, **hardware decoding (Intel Media SDK / VA-API)** |
| [sound.md](sound.md) | SmartXbar inputs, live playback without lag, sources and the volume |
| [input.md](input.md) | Touch PDUs, the iDrive controller (FrontCCU), gamepads |
| [vehicle-data.md](vehicle-data.md) | Speed, gear, parking brake: "only while parked" |
| [vehicle-signals.md](vehicle-signals.md) | The cluster themes' readings (rpm, temperatures, drive mode, fuel, tyres, g, navigation...): the SOME/IP field for each in our firmware's catalog, scaling, manifest access, notify vs poll |
| [idrive-app-ui.md](idrive-app-ui.md) | RHMI pages: templates, drop-downs and other selections, gotchas, pop-ups and focus |
| [store.md](store.md) | Releases, catalogs, `component.json` fields, the uplink's firewall |
| [browser.md](browser.md) | Chromium on the unit: what the image lacks (Vulkan), **GPU drivers only with a safety net**, Vulkan on the 4.14 kernel (Mesa history), bringing a newer userland, WebGPU / JSPI in headless Chromium |
| [games.md](games.md) | Windows games through Proton / Wine: WineD3D on Mesa 19, GL frames as PRIME buffers, the adapter's name, Proton without Python, the prefix, DepotDownloader |
| [game-compatibility.md](game-compatibility.md) | Which Steam games run: Supported / Unsupported / Untested, the unit as a desktop, the rule of thumb, the Black Ops 1 era |
| [bench.md](bench.md) | Working off the car: PCs, containers, emulators, **the unit's own Winston** |
| [reference-repos.md](reference-repos.md) | The other iDrive repositories we read, their licenses and what each is good for |

Add a fact to the file it belongs to (or a new file listed here), with the
date or source when it isn't obvious; correct a wrong one in place.
