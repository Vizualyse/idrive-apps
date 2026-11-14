# vizualyse_cluster

The iDrive 7 app for [vizualyse-cluster](../../native/vizualyse-cluster)
(Cluster themes): whole-cluster themes drawn over the instrument cluster.
The tile is **Cluster themes**.

## The page

One `LT_State_Wide` page, all of it usable with the iDrive controller:

| Row | What it does |
|---|---|
| status | `On the cluster: G20 inspired 1 (Comfort)`, `Off - the car's own cluster shows`, `The picker is on the screen - the back arrow on the left returns here`, `Trying a theme on the cluster...`, `Error: ...` (a failed command's, for 10 s), `The cluster: ...` (the tool's), `The cluster themes tool is not running - ...` |
| Choose with previews (touch the screen) | opens the empty screen state, then `picker`: the tool's picker over the app area (below). Off while the car moves (`(only while parked)`) |
| a row per family (eight) | `use` with that family: on the cluster, themes on. The one in use says `In use: ` |
| Sport or Comfort: by the drive mode / always Sport / always Comfort | `mode`, the next of the three |
| The car's strip under the theme: shown / covered (black) | `cover` |
| Cluster themes: on / off (the car's own cluster) | `enable` / `disable` |

Texts are plain ASCII (RHMI Text is not a reliable Unicode transport on this
firmware: knowledge/idrive-app-ui.md); the tool's theme titles (`G20
inspired 1 · Comfort`) become the family's (`G20 inspired 1`).

## The picker, and touches under it

The picker is the tool's, drawn in mgu-render's app area (not the HMI's
title bar or left strip) and read by touch: a large preview of every theme
in Sport and Comfort, Use, a 10 s Try on the cluster while parked, Auto /
Sport / Comfort, Turn themes off ([the tool's README](../../native/vizualyse-cluster/README.md#the-picker-on-the-central-screen)).

As vizualyse_steam: the HMI still gets every touch on it, so **Choose**
first opens the screen state (`ST_OnlineApps_VizualyseClusterScreen`, a
title and one label, nothing to press) and sends `picker` once it is
visible; while the picker is up every button of the main page is disabled
too. Should the HMI not open the screen state within 3 s, the picker goes
over the main page (its buttons disabled) and the log says why. BACK, HOME,
another app, and a pop-up, a call or a warning taking the focus for 300 ms
hide it (`picker` with `on: false`). The app also hides it as it shuts down.

The iDrive controller works this page, not the picker (the knob reaches only
RHMI states: knowledge/input.md); everything the picker does but Try and the
previews is a row here.

## Only while parked

The app reads `Vehicle2.statusCarSpeed2` every second (`src/vehicle_speed.js`)
and sends `{"cmd":"speed","kmh":N}`; the tool hides the picker above 3 km/h
and won't show it, and tries a theme only at a standstill. The theme rows
work while driving (only the cluster changes).

## The car's readings

`src/vehicle_signals.js` reads the car over SOME/IP and sends the theme its
readings as `{"cmd":"signals", ...}` in the tool's names
(`native/vizualyse-cluster/src/sim.js`): what changed within 100 ms, and
everything once a second (the tool forgets a reading after 2 s). Where each
comes from and how it is scaled: [knowledge/vehicle-signals.md](../../knowledge/vehicle-signals.md).

| Signal | From |
|---|---|
| `kmh` | `Vehicle2.statusCarSpeed2` (subscribed; also polled for the parked gate) |
| `rpm`, `oilC`, `coolantC` | `CDS.statusEngineSpeed2`, `statusEngineTemperature` |
| `gLat`, `gLon` | `CDS2` accelerations |
| `gear`, `gearPos` | `VehicleInformation.DataPowerTrain2` (notifier only) |
| `gearMode` | `MDrive.dataDisplayGearbox` (notifier only): `S`, `M`, `D` |
| `driveMode` | `FES.statusFESVehicleDynamicSwitchHMI`: `SPORT` (Sport, Sport+, PHEV Sport) picks Sport, anything else Comfort |
| `engineHp` | `FES.statusActualValueTorque2` x rpm |
| `boostBar`*, `throttle`* | `FES.statusSwitchDriveDynamicSport2`, `AcceleratorPedal` |
| `outsideC` | `EnvironmentalInformation.ExteriorTemperature` |
| `fuelL`, `rangeKm`, `odoKm` | `KombiIF.statusRangeTankStatus` |
| `evRangeKm`*, `socPct`* | `KombiIF.displayRangeElectricVehicle`, `Efficiencytainment2.statusChargeOfBatteryHybrid` |
| `tripKm`*, `avgKmh`*, `avgL100`* | `KombiIF` trip computer (its own units converted) |
| `tyres` | `TPMS` pressures and temperatures, in the car's units (`Vehicle`'s units status, else from the size) |

\* a scaling not yet checked against the car: the raw value is logged once
(`signals: <field> raw ...`). The theme's fuel gauge wants `fuelPct`; the
car gives litres, so it shows `--` until the tank's size is known. Not read
yet: the speed limit, cruise speed, navigation, electric power.

Before a manifest change goes to the car: `node tools/check_signals.js
<someip-interfaces.json>` against the unit's catalog (BMW's installer
refuses the whole app for one field it lacks).

## The socket

`/dev/shm/vizualyse-cluster/ctl.sock` (`CLUSTER_CTL_SOCKET` overrides it), a
Unix stream socket, newline-delimited JSON, open to this app's group only.
The tool sends `{"ev":"status", ...}` (`enabled`, `theme`, `mode`, `cover`,
`showing`, `themes`, `picker`, `trying`, `moving`, `error`, ...) on
connect, after each command and once a second, and
`{"ev":"error","error":...}` for a failed command; the app sends `use`
(`id`), `mode`, `cover`, `enable`, `disable`, `picker` (`on`) and, every
second, `speed`.

## Building and testing

- `node tools/make_page.js vizualyse_cluster@0.2.0` writes `application.xml`
  and `uiDescription.json` from one list; `node tools/make_icon.js <png>`
  the tile icon (a gauge).
- `node tools/test_page.js` runs the app against a fake SDK, HMI and tool
  socket (what it covers is at its top).
- `node tools/build.js` packs the source package
  (`vizualyse_cluster@<version>.src.tgz`) the head unit builds.

GPL-3.0-or-later. `src/vehicle_speed.js` is a copy of the platform's
(`release.json` "platform", [platform/](../../platform)).
