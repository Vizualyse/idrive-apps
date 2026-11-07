// policy.js: the vsomeip security entries the emulator needs, added at boot
// (idempotent: always from the unit's own file, saved once as *.orig).
//
// vsomeip checks a request in the serving process, against that process's
// own policy file (/etc/vsomeip/<uid>_<gid>/vsomeip_security.json). carsim
// runs as root: root's file has to let the HMI (and anyone local) request
// the stand-in services; the HMI's file has to let root call its HmiTest.
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
var fs = require('fs');

function patch(file, add) {
  var orig = file + '.orig';
  if (!fs.existsSync(orig)) fs.writeFileSync(orig, fs.readFileSync(file));
  var j = JSON.parse(fs.readFileSync(orig, 'utf8'));
  add(j.security.policies);
  fs.writeFileSync(file, JSON.stringify(j, null, 2));
  console.log('policy: ' + file + ' (' + j.security.policies.length + ' policies)');
}

var ANY = { uid: [{ first: '0', last: '65534' }], gid: [{ first: '0', last: '65534' }] };
// Lifecycle, VehicleCondition, Key, Vehicle, FrontCCU (carsim.js)
var CARSIM = ['0xb015', '0x1531', '0x5535', '0xb510', '0xb508'];

patch('/etc/vsomeip/0_0/vsomeip_security.json', function (p) {
  p.push({ credentials: ANY, allow: { requests: CARSIM.map(function (s) { return { service: s, instance: 'any' }; }) } });
});
patch('/etc/vsomeip/5000_5000/vsomeip_security.json', function (p) {
  p.push({ credentials: { uid: '0', gid: '0' }, allow: { requests: [{ service: '0xb066', instance: 'any' }] } });
});
