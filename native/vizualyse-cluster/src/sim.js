// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The bench simulation: a made-up drive that loops (a launch through the
 * gears, braking with downshifts and regen, a corner, a short pull, a stop),
 * so a theme can be watched without a car. Never shown as real: the tool
 * says DEMO while it runs and refuses it while the car moves.
 *
 * Integrated once at 50 Hz when loaded; at(t) samples it, so the preview can
 * hold any moment (?t=12.5). Signals, in the car's own units:
 *   kmh, rpm, gear (1..6, 0 neutral), gearMode ('M'), throttle 0..1, brake 0..1,
 *   engineHp, elecHp (negative: regen), socPct, evRangeKm, fuelPct, rangeKm,
 *   oilC, coolantC, boostBar, tyres [{ bar, c } x4: FL FR RL RR],
 *   outsideC, odoKm, gLat, gLon, driveMode ('SPORT' / 'COMFORT'), clock ('HH:MM'),
 *   tripKm, avgL100, avgKmh, instL100, limitKmh, cruiseKmh (null: off),
 *   turnDir ('left'/'right'), turnM, road, destKm, eta ('HH:MM'), volts12, evTripKm
 * Two drives: at(t) the Sport one (gearMode 'M'), at(t, 'comfort') a calm one in D.
 * Node 8 and the browser (module.exports, or window.ClusterSim).
 */
(function (root) {
    'use strict';
    const HZ = 50;
    const RATIOS = [3.5, 2.3, 1.65, 1.25, 1.0, 0.83];
    const KMH_PER_KRPM = 31.6;   /* in a 1.0 gear */
    const MASS = 1800, SHIFT = 6600, IDLE = 850, LIMIT = 7000;

    function engineCurve(rpm) {
        let c = rpm < 1500 ? 0.25 : Math.min(1, (rpm - 1000) / 4500);
        if (rpm > 6200) c *= 1 - (rpm - 6200) / 4000;
        return c;
    }

    /* The script: [seconds, what the driver does] */
    const SCRIPT = [
        [1.5, { throttle: 0, brake: 0 }],          /* idle */
        [13, { throttle: 1, brake: 0, upTo: 190 }],  /* launch, through the gears */
        [1.0, { throttle: 0, brake: 0 }],          /* lift */
        [4.0, { throttle: 0, brake: 0.85, downTo: 60 }],
        [3.5, { throttle: 0.35, brake: 0, corner: 0.8, hold: 60 }],
        [4.0, { throttle: 0.9, brake: 0, upTo: 120 }],
        [3.5, { throttle: 0, brake: 0.6, downTo: 0 }],
        [2.0, { throttle: 0, brake: 0 }],
    ];

    /* Comfort: a calm drive in D: gentle pulls shifting early, a cruise, a
     * long regen coast, a stop. */
    const COMFORT = [
        [2.0, { throttle: 0, brake: 0 }],
        [9.0, { throttle: 0.35, brake: 0, upTo: 80 }],
        [6.0, { throttle: 0.2, brake: 0, hold: 80 }],
        [5.0, { throttle: 0.45, brake: 0, upTo: 110 }],
        [6.0, { throttle: 0.2, brake: 0, hold: 110 }],
        [6.0, { throttle: 0, brake: 0.25, downTo: 50 }],
        [4.0, { throttle: 0.2, brake: 0, hold: 50, corner: 0.25 }],
        [4.5, { throttle: 0, brake: 0.35, downTo: 0 }],
        [2.5, { throttle: 0, brake: 0 }],
    ];

    function run(mode) {
        const comfort = mode === 'comfort';
        const script = comfort ? COMFORT : SCRIPT;
        const shift = comfort ? 2300 : SHIFT, down = comfort ? 1300 : 2600, upAt = comfort ? 0.15 : 0.5;
        const frames = [];
        const s = { kmh: 0, gear: 1, soc: 72, fuel: 46, heat: 0, odo: 23581.4, oil: comfort ? 92 : 96 };
        script.forEach((step) => {
            const n = Math.round(step[0] * HZ), d = step[1];
            for (let i = 0; i < n; i++) {
                const dt = 1 / HZ;
                let throttle = d.throttle, brake = d.brake;
                if (d.upTo != null && s.kmh >= d.upTo) throttle = 0.15;
                if (d.downTo != null && s.kmh <= d.downTo) brake = 0;
                if (d.hold != null) throttle = s.kmh < d.hold - 1 ? (comfort ? 0.3 : 0.45) : (comfort ? 0.12 : 0.2);
                let rpm = Math.max(IDLE, s.kmh / KMH_PER_KRPM * RATIOS[s.gear - 1] * 1000);
                /* the driver's shifts (or the gearbox's in D): up at the shift point, down to keep the revs up */
                if (throttle > upAt && rpm >= shift && s.gear < 6) { s.gear++; rpm = s.kmh / KMH_PER_KRPM * RATIOS[s.gear - 1] * 1000; }
                if ((brake > 0 || throttle < upAt) && s.gear > 1 && rpm < down) { s.gear--; rpm = Math.max(IDLE, s.kmh / KMH_PER_KRPM * RATIOS[s.gear - 1] * 1000); }
                if (s.kmh < 1) { s.gear = 1; }
                rpm = Math.min(LIMIT, rpm);
                const engineHp = Math.round(387 * engineCurve(rpm) * throttle);
                let elecHp = s.soc > 20 ? 109 * throttle * (rpm < 4500 ? 1 : Math.max(0.3, 1 - (rpm - 4500) / 3000)) : 0;
                if (brake > 0 && s.kmh > 5) elecHp = -Math.min(80, 95 * brake);
                elecHp = Math.round(elecHp);
                const ms = s.kmh / 3.6;
                const power = Math.max(0, engineHp + elecHp) * 745.7 * 0.85;
                let acc = power > 0 ? Math.min(9.5, power / (MASS * Math.max(ms, 3))) : 0;
                acc -= brake * 9.0 + 0.0004 * ms * ms + 0.15;
                if (ms <= 0 && acc < 0) acc = 0;
                s.kmh = Math.max(0, (ms + acc * dt) * 3.6);
                s.soc = Math.max(15, Math.min(95, s.soc - elecHp * 0.00004));
                s.fuel = Math.max(5, s.fuel - engineHp * 0.0000015);
                s.odo += s.kmh / 3600 * dt;
                const gLat = d.corner ? d.corner * Math.min(1, i / 25) : 0;
                s.heat = Math.min(1, Math.max(0, s.heat + (Math.abs(gLat) * 0.02 + Math.abs(acc) * 0.002 - 0.003) * dt * 10));
                s.oil = Math.min(118, s.oil + (engineHp / 387 - 0.35) * 0.08 * dt * 10);
                frames.push({
                    kmh: s.kmh, rpm: Math.round(rpm), gear: s.gear, gearMode: comfort ? 'D' : 'M',
                    throttle, brake, engineHp, elecHp,
                    socPct: s.soc, evRangeKm: s.soc * 0.55, fuelPct: s.fuel, rangeKm: s.fuel * 10.8,
                    oilC: s.oil, coolantC: 91 + s.heat * 6,
                    boostBar: throttle > 0.1 ? Math.min(1.2, rpm / 4000 * 1.2) * throttle : -0.6,
                    tyres: [0, 1, 2, 3].map((k) => ({ bar: [2.4, 2.4, 2.6, 2.5][k] + s.heat * 0.15, c: 48 + s.heat * (k % 2 ? 34 : 30) + (k < 2 ? 3 : 0) })),
                    outsideC: 11.5, odoKm: s.odo, gLat, gLon: acc / 9.81, driveMode: comfort ? 'COMFORT' : 'SPORT',
                    clock: '18:05', tripKm: 112.4 + (s.odo - 23581.4), avgL100: comfort ? 6.4 : 9.8, avgKmh: comfort ? 58 : 74,
                    /* Comfort's: the road's limit, cruise, the next turn, the trip's end */
                    limitKmh: s.kmh > 90 ? 113 : s.kmh > 55 ? 97 : 48,
                    cruiseKmh: d.hold != null && comfort ? d.hold : null,
                    instL100: throttle > 0.05 ? Math.min(30, 4 + engineHp * 0.08) : 0,
                    turnDir: (Math.floor(s.odo * 2) % 2) ? 'right' : 'left', turnM: Math.max(0, 800 - ((s.odo * 1000) % 800)),
                    road: 'Ring Road', destKm: Math.max(0, 42 - (s.odo - 23581.4)), eta: '18:41',
                    volts12: brake > 0 ? 14.4 : 14.1, evTripKm: 18.6 + (s.odo - 23581.4) * 0.3,
                });
            }
        });
        return frames;
    }

    const runs = {};
    function frames(mode) { mode = mode === 'comfort' ? 'comfort' : 'sport'; return runs[mode] || (runs[mode] = run(mode)); }
    /* mode: 'sport' (default) or 'comfort' */
    function at(t, mode) {
        const f = frames(mode);
        const n = f.length;
        const i = Math.floor(((t * HZ) % n + n) % n);
        return f[i];
    }
    function length(mode) { return frames(mode).length / HZ; }

    const api = { at, length, SHIFT, LIMIT };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.ClusterSim = api;
})(this);
