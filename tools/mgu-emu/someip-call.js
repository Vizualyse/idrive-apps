// someip-call.js: one SOME/IP call through the unit's /usr/lib/someip.node,
// as root, for poking the HMI and the car stand-ins in the emulator.
//
//   node someip-call.js IFACE.json INSTANCE get FIELD
//   node someip-call.js IFACE.json INSTANCE set FIELD 'JSON'
//   node someip-call.js IFACE.json INSTANCE call METHOD '{"param": ...}'
//
// IFACE.json comes from the unit's catalog: python tools/someip_iface.py
// <someip-interfaces.json> gen <interface> "" IFACE.json. INSTANCE is the
// catalog's instance name (e.g. 1, Front, HMI_CID).
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
var path = require('path');
var someip = require('/usr/lib/someip.node');
var a = process.argv.slice(2);
if (a.length < 4) { console.error('usage: someip-call.js IFACE.json INSTANCE get|set|call NAME [JSON]'); process.exit(64); }
var cfg = require(path.resolve(a[0]));
var inst = a[1], op = a[2], name = a[3], arg = a[4] ? JSON.parse(a[4]) : {};
var T = +(process.env.SOMEIP_TIMEOUT || 30000);
var timer = setTimeout(function () { console.error('someip-call: no answer'); process.exit(2); }, T + 10000);

setImmediate(function () {
  someip.buildProxy(cfg, inst)
    .then(function (p) { return p.init().then(function () { return p; }); })
    .then(function (p) {
      return p.subscribeToAvailability(function () {})
        .then(function () { return p.waitUntilAvailable(T); })
        .then(function () {
          if (op === 'get') return p.getValue(name, T);
          if (op === 'set') return p.setValue(name, arg, T);
          if (op === 'call') return p.callMethod(name, arg, T);
          throw new Error('unknown op ' + op);
        })
        .then(function (r) { clearTimeout(timer); console.log(JSON.stringify(r, null, 1)); return p.shutdown(); });
    })
    .then(function () { process.exit(0); })
    .catch(function (e) { clearTimeout(timer); console.error('someip-call:', e && e.message || e); process.exit(1); });
});
