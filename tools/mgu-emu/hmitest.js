// hmitest.js COMMAND [DATA]: sends one command to the HMI's own test
// interface (de.bmw.infotainment.hmi.hmitest.HmiTest, SOME/IP 0xB066 inst 1,
// sendCommand) through the unit's /usr/lib/someip.node, as root, and prints
// the reply. "help" lists the commands the HMI has registered.
//
//   node /usr/lib/mgu-emu/hmitest.js help
//
// The interface JSON (HmiTest.json beside this file) is made from the unit's
// catalog: python tools/someip_iface.py <someip-interfaces.json> gen
//   de.bmw.infotainment.hmi.hmitest.HmiTest "" HmiTest.json
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
var path = require('path');
var someip = require('/usr/lib/someip.node');
var cfg = require(path.join(__dirname, 'HmiTest.json'));
var cmd = process.argv[2] || 'help', data = process.argv[3] || '';
var timer = setTimeout(function () { console.error('hmitest: no answer (is the HMI up?)'); process.exit(2); }, 20000);

setImmediate(function () {
  someip.buildProxy(cfg, process.env.HMITEST_INSTANCE || '1')
    .then(function (p) { return p.init().then(function () { return p; }); })
    .then(function (p) {
      return p.subscribeToAvailability(function () {}).then(function () { return p.waitUntilAvailable ? p.waitUntilAvailable(15000) : null; })
        .then(function () { return p.callMethod('sendCommand', { commandId: cmd, commandData: data }, 15000); })
        .then(function (r) {
          clearTimeout(timer);
          console.log('errorCode:', r && r.errorCode);
          console.log(r && r.returnData);
          return p.shutdown();
        });
    })
    .then(function () { process.exit(0); })
    .catch(function (e) { clearTimeout(timer); console.error('hmitest:', e && e.stack || e); process.exit(1); });
});
