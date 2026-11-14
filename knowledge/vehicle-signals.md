# Vehicle signals (for the cluster themes)

Which car readings an iDrive app can read over SOME/IP on our firmware, for
`native/vizualyse-cluster` (names from its `src/sim.js`). Speed, gear and
parking brake for "only while parked": [vehicle-data.md](vehicle-data.md).
Index: [index.md](index.md).

**Nothing here has been read on our car yet** (2026-11-13). Two kinds of fact:

- **cat**: in our unit's own SOME/IP catalog, `/etc/oap/someip/someip-interfaces.json`
  (catalog version 5, 591 interfaces), read from the rootfs copy
  (`idrive-rootfs/20.40.2/rootfs.tar`). It says the interface, field, members
  and access (g getter, n notifier) exist on `I_21w12.2-1-4`, and that the
  installer will take a manifest asking for them. It does not say the car
  sends them, or their scaling.
- *(ref: …)*: meaning and scaling from cauliflowermossgrape/idrive7-apps
  `9f0f68a` (2026-11-13; MIT; their firmware `P18_23w44.2`, many cars through
  Redline / M Vitals / Live Data). "q" marks a scaling they call a best guess.
  IterioDev/car-apps (`cdab455`) is iDrive 8 first: nothing below needs it.
  Upstream (`d0bae2d`) and mgu-store (`9c2360a`) read no vehicle signals.

## How an app reads one

- Manifest `proxies`: `"<interface>": {"instances": ["1"], "attributes": {"<field>": "rs"}}`.
  `r` needs the field's getter, `s` (subscribe) its notifier, `w` its setter
  (ref: idrive7-apps `kit/tools/build.py:458-466`). Notifier-only fields
  (`[-n-]` below) take `"s"` only and can't be polled.
- BMW's installer refuses the **whole app** for one field, access or instance
  its catalog lacks ("Requested read for statusBattery2 but no getter
  available": some units' CDS lack it) (ref: `kit/tools/build.py:400-403`).
  Check every entry against our catalog; all those below are in it.
- Instance `'1'` for all, except `Guidance` (`Main_Instance`) and `LevelMonitor` (`Inst1`) (cat).
- **Update:** fields notify on change, so a parked car sends nothing new for
  minutes; they `getValue()` once, then subscribe (ref: `kit/runtime/signals.js:47-75`,
  `kit/runtime/car.js:150`). TPMS and KombiIF are also polled every 10 s:
  BMW's own x_call only ever reads TPMS (ref: `apps/live_data/signals.js:27-28`).
  For our speed we poll every 1 s ([vehicle-data.md](vehicle-data.md)).
- Enums arrive as names or numbers; handle both (ref).
- Firmware's own OAP main app reads a few of these itself
  (`/usr/lib/oap-mainapp/src-gen/someip/`, cat): Vehicle2 `statusCarSpeed2`,
  CDS `statusEngineSpeed2`, CDS2 `statusLongitudinalAccelerationMassCenter`,
  KombiIF `statusRangeTankStatus`, VehicleInformation `DataPowerTrain2` / `Range`,
  EnvironmentalInformation `ExteriorTemperature`, Guidance `guidanceState`,
  `finalDestinationInfo`, `nextDestinationInfo`, `travelledDistance`.

## The table

Interfaces shortened: `vehicle.CDS`, `vehicle.CDS2`, `vehicle.Vehicle2`,
`vehicle.TPMS` are `de.bmw.infotainment.vehicle.*`; `FES`, `Efficiencytainment2`
are `de.bmw.infotainment.drivingexcitement.*`; `KombiIF` is
`de.bmw.infotainment.KombiIF`; `VehicleInformation`, `EnvironmentalInformation`
are `de.bmw.infrastructure.*`; `MDrive` is `de.bmw.infotainment.misc.MDrive`;
`Guidance` is `de.bmw.infotainment.navigation.guiding.Guidance`;
`DisplayDataServer` is `de.bmw.infotainment.displaydataserver.DisplayDataServer`;
`FASuS` is `de.bmw.infotainment.fasus.FASuS`. "none" = the raw value meaning no data.

| sim.js | Interface . field . member | Units, scaling | iDrive 7 (ours) | Source |
|---|---|---|---|---|
| `kmh` | `vehicle.Vehicle2` . `statusCarSpeed2` . `speedVehicleCentreOfGravity` [gn] | raw ÷ 64 km/h; 65535 none | yes | cat; ref `signals.js:108`; our `platform/app/vehicle_speed` (not run on the car) |
| `rpm` | `vehicle.CDS` . `statusEngineSpeed2` . `actualValueRPMEngineCrankshaft` [gn] | × 0.25 rpm; 65535 none | yes | cat; ref `signals.js:63` |
| `gear` | `VehicleInformation` . `DataPowerTrain2` . `statusGearSelectionDrive` [n] | enum N 1, R 2, P 3, NP 4, `_1`..`_9` = 5..13 (gear 1-9) | yes (subscribe only) | cat; ref `signals.js:38-48` |
| `gear` (alt) | `VehicleInformation` . `statusGearboxDrive` . `statusActualGearDrive` [n] | R 1, N_OR_P 2, G1..G10 = 3..12; stage P 1 R 2 N 3 D 4 | yes (subscribe only); some cars never send it | cat; ref `signals.js:49-56`, [vehicle-data.md](vehicle-data.md) |
| `gearMode` | `MDrive` . `dataDisplayGearbox` . `displayProgramGearbox` [n] | `S_MINUS_PROGRAMM` 1 = S, `M_MINUS_PROGRAMM` 2 = M, `DUNKELSCHALTUNG` 0 = D (none shown) | yes (subscribe only) | cat; ref `apps/redline/main.js:81,171-179` |
| `driveMode` | `FES` . `statusFESVehicleDynamicSwitchHMI` . `actualValueModeDrivingExperience` [gn] | 1 Sport, 2 Sport+, 3 Sport Ind., 4 Comfort, 5 Comfort+, 6 Comfort Ind., 7 Eco Pro, 8 Eco Pro+, 9 Eco Pro Ind., 10 Adaptive; 0 / 61-63 none: keep the last mode (sent as the car switches off) | yes | cat; ref `signals.js:110`, `apps/redline/main.js:150-156` |
| `oilC` | `vehicle.CDS` . `statusEngineTemperature` . `temperatureEngineOilDrive` [gn] | raw − 48 °C; 255 none (BMW's converter) | yes | cat; ref `signals.js:75` |
| `coolantC` | same field . `temperatureEngineDrive` | raw − 48 °C; 255 none | yes | cat; ref `signals.js:74` |
| `outsideC` | `EnvironmentalInformation` . `ExteriorTemperature` . `temperatureExterior` [n] | raw × 0.5 − 40 °C; 255 none | yes (subscribe only) | cat; ref `signals.js:119` |
| `fuelPct` | `KombiIF` . `statusRangeTankStatus` . `fluidLevelFuelTank` [gn] | **litres**, ≥ 255 none: a % needs the tank's size | yes (litres) | cat; ref `signals.js:81` |
| `rangeKm` | same field . `range` | km; ≥ 4095 none | yes | cat; ref `signals.js:84` |
| `odoKm` | same field . `mileageKilometre` | km; ≥ 16777215 none. Alt: `VehicleInformation.Range.mileageKilometre` [n] | yes | cat; ref `signals.js:85` |
| `socPct` | `Efficiencytainment2` . `statusChargeOfBatteryHybrid` . `displayChargingConditionHighVoltageStorage` [gn] | UInt8, scaling unknown (display %?) | in catalog; meaning unconfirmed | cat; ref reads it (`apps/redline/app.json`) but takes SoC over UDS |
| `evRangeKm` | `KombiIF` . `displayRangeElectricVehicle` . `displayRangeElectricVehicle` [gn] | UInt16, scaling unknown | in catalog; unconfirmed | cat |
| `engineHp` | `FES` . `statusVehicleDynamicEngine` . `displaySportEnginePower` [gn] × `statusVehicleDynamicEngineMaxValue.displayMaximumValuePower` [gn] | % of max (255 none) × the car's max (raw, unscaled); or torque × rpm ÷ 9549 kW from `FES.statusActualValueTorque2.actualValueTorqueCrankshaft` (× 0.5 − 1023.5 Nm, ≥ 4095 none) | yes (two routes) | cat; ref `signals.js:65-67` |
| `elecHp` | `Efficiencytainment2` . `statusPowerRelativHybrid` . `displayActualValuePowerRelativeDrivingElectric` / `…Recuperation` [gn] | relative (UInt8), scaling unknown; `FES.displaySportPowertrain` [n] also | in catalog; unscaled | cat; ref logs it raw for learning (`apps/redline/app.json`) |
| `boostBar` | `FES` . `statusSwitchDriveDynamicSport2` . `displayBoostPressure` [gn] | × 0.01 bar (q); 255 none; not every car sends it | yes, scale unconfirmed | cat; ref `signals.js:71`, `apps/redline/main.js:157-162` |
| `tyres[].bar` | `vehicle.TPMS` . `statusTyrePressure` . `actualValuePressureTyre{FLH,FRH,RLH,RRH}` [gn] | × 0.1 in the car's pressure unit (bar / kPa / psi, from `vehicle.Vehicle.statusNewCurrentUnitsStatusExt`); ≥ 65532 none; poll | yes | cat; ref `apps/redline/tyres.js:9-16` |
| `tyres[].c` | `vehicle.TPMS` . `statusTyreTemperature` . `actualValueTemperatureTyre{…}` [gn] | raw − 40 in the car's temperature unit; 65535 none | yes | cat; ref `tyres.js:12` ("seen on a car") |
| `gLat` | `vehicle.CDS2` . `statusLateralAccelerationMassCenter` . `lateralAccelerationCentreOfGravity` [gn] | (raw × 0.002 − 65) m/s², ÷ 9.80665 = g; 65535 none | yes | cat; ref `signals.js:112` |
| `gLon` | `vehicle.CDS2` . `statusLongitudinalAccelerationMassCenter` . `longitudinalAccelerationCentreOfGravity` [gn] | same | yes | cat; ref `signals.js:111` |
| `throttle` | `de.bmw.powertrain.AcceleratorPedal` . `AngleAcceleratorPedal` . `actualValueAngleAcceleratorPedal` [n] | × 0.025 % (q) | yes (subscribe only), scale unconfirmed | cat; ref `signals.js:73` |
| `brake` | `de.bmw.chassis.VehicleStabilizationManagement` . `StabilizationManagement` . `statusBrakingDriver` [n] | raw (on / off?) | in catalog; unconfirmed | cat; ref `signals.js:143` |
| `avgL100` | `KombiIF` . `statusBordcomputerAverage` . `consumptionAverage1BC1` (trip 2: `…2BC2`) [gn] | × 0.1 (q) in `statusUnitOfMeasurementConsumptionBC` (l/100 km, mpg UK / US, km/l); 65535 none | yes | cat; ref `signals.js:91` |
| `avgKmh` | same field . `speedAverage1BC1` | × 0.1 (q) in `statusUnitOfMeasurementSpeedBC`; 65535 none | yes | cat; ref `signals.js:92` |
| `tripKm` | `KombiIF` . `statusBordcomputerTravelData` . `wayPassed` (+ `rideDurationHours` / `Minutes`) [gn] | km (q); 65535 none | yes | cat; ref `signals.js:95-97` |
| `instL100` | `de.bmw.infotainment.resetlogic.ResetLogic` . `currentConsumption` [gn] | `consumptionCombustionCurrentScale` / `…Digit` + `combustionUnit`: scaling unknown | in catalog; unscaled | cat; ref logs it raw (`apps/redline/app.json`) |
| `volts12` | not found as a signal. `vehicle.CDS.statusBattery2.conditionBatteryChargingCondition` [gn] is the 12 V **charge %** (≥ 151 none), not volts; `com.harman…levelmonitor.LevelMonitor.systemVoltage` [gn] is the head unit's own supply, scale unknown | — | not found (charge % instead) | cat; ref `signals.js:120`; ref reads volts over UDS |
| `limitKmh` | candidates, read by nobody: `DisplayDataServer` . `functionalLibraryData` . `xSpeedLimitAssist.vSLISpeedValue` (+ `countryCode` ECE / US) [gn]; `FASuS.statusNextSpeedLimitRecognition` (the *next* limit, 5 km/h classes) [gn]; `de.bmw.dass.DisplayForesight.displayForesight` [n] | UInt8, unit unknown | candidate | cat only |
| `cruiseKmh` | candidates, read by nobody: `DisplayDataServer` . `functionalLibraryData` . `cruiseCtrlSpeedHUD` (+ `ldmSym` ACC / DCC, `statusLimiter`) [gn]; `FASuS.displayDriverAssistenceSystemLongitudinalGuidance.valueRequestSpeed` [n] | UInt16, unit unknown | candidate | cat only |
| `turnDir`, `turnM` | `Guidance` (`Main_Instance`) . `nextIntersection` [gn]: `intersection` (description), `distance` {`distance` text, `unit` NONE / KM / METER / MILE / YARD / FEET, `rawDistance`}; the manoeuvre from `conclusiveDart` [gn] or `GuidanceEventList.queryContent` (a method) | text + unit; direction from the manoeuvre | yes (BMW navigation); CarPlay routes differ | cat; ref `apps/redline/nav.js:9-16` |
| `road` | `Guidance` . `currentRoad` [gn] | `elements[].text` | yes | cat |
| `destKm`, `eta` | `Guidance` . `finalDestinationInfo` [gn]: `formattedDistance`, `estimatedArrivalTime` (date, time), `travelTime` (s) | text + unit; time of day | yes (BMW navigation) | cat (main app reads it too) |
| `clock` | the unit's own clock; `KombiIF.statusTimeDate.statusTimeZonesOffset` [gn] for the zone | head unit time is UTC on the cars seen so far | yes | cat; ref `apps/redline/logview.js:108` |
| `evTripKm` | not found as one field (`ResetLogic.bcDataAll` has trip averages incl. electric) | — | not found | cat |

None of the readings the themes want is iDrive 8 only: every row is in our
iDrive 7 catalog, under the same names idrive7-apps uses on `P18_23w44.2`.

## Notes

- **Navigation:** during a CarPlay route `guidanceState` stays INACTIVE; the
  phone's turns come through `GuidanceEventList.queryContent` and
  `CarPlayManager.projectedGuidanceActive` (`CarPlayManagerInst1`) (ref:
  `apps/redline/nav.js:9-16`, their CarPlay, not our 20.40.2).
- **DisplayDataServer** looks like the HUD's own feed (speed, `rpm`,
  `currentGear`, ACC symbol and bars, the speed-limit sign, cruise speed).
  Our unit has only its *proxy* library
  (`libde.bmw.infotainment.displaydataserver.proxy.someip.so`): another unit
  on the car serves it. Whether it is sent on our car is unknown.
- `vehicle.Vehicle2.statusDisplayKombi.statusDisplayInstrumentPackM` [gn]:
  the cluster's view (STANDARD_VIEW 1, M_VIEW 2, M_VIEW_PLUS 3) (cat).
- `MDrive`, `VehicleInformation`, `EnvironmentalInformation` and `AcceleratorPedal`
  have no getter on our firmware: subscribe, and hold the last value.
- The ref's scalings marked q (boost, trip averages, pedal) are their best
  guesses; their apps log raw values to calibrate against the cluster.
