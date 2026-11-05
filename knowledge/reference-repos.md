# Reference repositories

Other people's iDrive work we read for ideas (2026-11-05, read only, nothing
run). What we took from them is in the topic files, marked *(ref: repo
path)*. Those facts are **not yet checked on our unit** unless a line says so.

| Repo | Commit read | License | Good for |
|---|---|---|---|
| [robertnisipeanu/idrive-apps](https://github.com/robertnisipeanu/idrive-apps) (our `upstream`) | `daaa3f7` | GPL-3.0 (cluster-render clients MPL-2.0) | cluster-render 0.4.0, waze-on-cluster: **hardware H.264 decoding through Intel Media SDK on iDrive 7**, the firmware's library ABI lists, CarPlay 22.28.3 patching, the RHMI drop-down, unit hazards |
| [robertnisipeanu/mgu-store](https://github.com/robertnisipeanu/mgu-store) | `648c787` | GPL-3.0 | the Store, mgu-render, mgu-deploy, mgu-uplink (which our tools run on) |
| [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) | `97ee84d` | MIT | iDrive 7 RHMI widgets and gotchas, an oap-sdk wrapper, vehicle signals, the iDrive controller (FrontCCU), Wayland/ivi onto the centre screen, in-page video |
| [IterioDev/car-apps](https://github.com/IterioDev/car-apps) | `41b5e0a` | **PolyForm Strict 1.0.0**: facts and protocols only, **no code may be copied or derived** (except its MIT `renderer/kit/`) | iDrive 8 first; the renderer protocol, winston-grabber, vehicle signals, an OAP media player lead for sound |

Notes:

- Our fetched `upstream/main` was behind the GitHub default branch; `git fetch upstream` brings `daaa3f7` (cluster-render 0.4.0, waze-on-cluster 0.9.0, the HUD). Our fork has none of `native/cluster-render`, `native/waze-on-cluster` or `apps/robertn_waze_cluster`; our Cast requires cluster-render 0.3.3.
- waze-on-cluster's `decoder_msdk.cpp` is GPL-3.0, like our tools: it can be ported into moonlight-core with attribution.
- IterioDev has a QEMU VM of the MGU (not published). cauliflowermossgrape has an off-car head-unit stub (`kit/tools/hu-stub.js`, `emu.js`) and `kit/tools/extract_sdk.js`, which rebuilds a readable oap-sdk tree from any app bundle: the real HMI API reference.
- Their units differ from ours: cauliflowermossgrape's firmware is `P18_23w44.2` (ours `I_21w12.2-1-4`), IterioDev's cars are iDrive 8, upstream runs carplay 22.28.3 (ours 20.40.2).
