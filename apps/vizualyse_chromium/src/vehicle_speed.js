// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The car's speed for "only while parked": Vehicle2.statusCarSpeed2
 * (instance '1', read: manifest.json), speedVehicleCentreOfGravity / 64 =
 * km/h, 65535 invalid (knowledge/vehicle-data.md). Read every POLL_MS, not
 * subscribed: a standing car may never notify a speed that doesn't change.
 * onSpeed(kmh) gets each valid reading; nothing while there is none (a
 * bench, the ignition off), and the tool then keeps what it was told last.
 */
'use strict';

const POLL_MS = 1000;
const INVALID = 65535;
const IFACE = 'de.bmw.infotainment.vehicle.Vehicle2';

/* someipBuilders: the SDK's (oap-sdk/src/someip/someipBuilders). Returns
 * stop(). */
function watchSpeed(someipBuilders, log, onSpeed) {
    let proxy = null, timer = null, busy = false, stopped = false, said = false;
    const read = () => {
        if (!proxy || busy || stopped) return;
        busy = true;
        Promise.resolve()
            .then(() => proxy.statusCarSpeed2.getValue())
            .then((v) => {
                const raw = v && v.speedVehicleCentreOfGravity;
                if (typeof raw !== 'number' || raw === INVALID) return;
                if (!said) { said = true; log.info('speed: reading ' + IFACE + ' (' + (raw / 64).toFixed(1) + ' km/h)'); }
                onSpeed(raw / 64);
            }, () => { /* not available now: the next poll tries again */ })
            .then(() => { busy = false; });
    };
    Promise.resolve()
        .then(() => someipBuilders.buildTypedProxy(IFACE, '1'))
        .then((p) => p.init().then(() => p))
        .then((p) => {
            if (stopped) return;
            proxy = p;
            read();
            timer = setInterval(read, POLL_MS);
        })
        .catch((err) => log.warn('speed unavailable from ' + IFACE + ': ' + (err && err.message)));
    return () => { stopped = true; clearInterval(timer); };
}

module.exports = { watchSpeed, POLL_MS };
