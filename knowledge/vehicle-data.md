# Vehicle data (speed, gear, parking brake)

For "only while parked" (Moonlight) and the like. All *(ref)*: not yet read
on our unit. Index: [index.md](index.md).

| What | Interface (SOME/IP, oap-sdk proxy) | Field | Values |
|---|---|---|---|
| Speed | `de.bmw.infotainment.vehicle.Vehicle2`, instance `'1'` | `statusCarSpeed2.speedVehicleCentreOfGravity` | ÷ 64 = km/h; 65535 invalid |
| Selector | `de.bmw.infrastructure.VehicleInformation` | `DataPowerTrain2.statusGearSelectionDrive` | N 1, R 2, **P 3**, NP 4 |
| Stage | same | `statusGearboxDrive.statusActualStageDrive` | P 1, R 2, N 3, D 4 (some cars never send it) |
| Parking brake | `de.bmw.infotainment.vehicle.CDS` | `statusHandBrake.statusContactHandBrake` | `HANDBREMSE_ANGEZOGEN`/2 applied, `GELOEST`/1 released |
| Vehicle state | `de.bmw.infrastructure.VehicleCondition` | `statusConditionVehicle` | 10 drive-ready, 7 ignition on, 5 "living" |
| Rpm | `de.bmw.infotainment.vehicle.CDS` | `statusEngineSpeed2.actualValueRPMEngineCrankshaft` | × 0.25 |

- **Poll, don't subscribe:** the notifiers often don't fire (a standing car
  may never notify); both repos call `getValue()` every 1-2 s
  (ref: IterioDev `src/main.js:15-17`; idrive7-apps `kit/runtime/parked.js:18-31`).
- Their rules: moving above 3 km/h from a sample under 3 s old; when the
  signal goes quiet keep the last state; no speed signal at all (bench, VM)
  counts as parked. IterioDev notes no P-position signal worked on one car,
  so speed is the signal to trust, gear/brake extra.
- Enum values arrive as names or numbers.
- Most vehicle data needs the ignition on.
- From an app: add the interface to `manifest.json`'s `proxies` as
  `"de.bmw.infotainment.vehicle.Vehicle2": {"instances": ["1"], "attributes": {"statusCarSpeed2": "r"}}`
  (upstream's Waze declares `HmiContext` this way), list
  `oap-sdk/src/someip/someipBuilders` in `mgu-app.json` `sdk`, then
  `someipBuilders.buildTypedProxy(iface, '1')`, `init()`,
  `proxy.statusCarSpeed2.getValue()` (Moonlight 0.2.0's
  `apps/vizualyse_moonlight/src/vehicle_speed.js`; not yet run on the car).
  Our firmware's catalog has a getter for `statusCarSpeed2` (id 8).
  The installer refuses a read flag on a field without a getter: check
  `/etc/oap/someip/someip-interfaces.json`.
- From a root tool: Node 8 `require('/usr/lib/someip.node')` with an interface
  JSON from `/usr/lib/oap-mainapp/src-gen/` (`buildProxy(cfg, inst).then(p => p.init())`)
  (ref: idrive7-apps `kit/renderd/js/foreground_gate.js:10-40, 168-200`).
  Simpler for us: the iDrive app reads the signals and tells the tool over
  its control socket.
