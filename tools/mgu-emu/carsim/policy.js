// policy.js: the vsomeip security entries the emulator needs, added at boot
// (idempotent: always from the unit's own file, saved once as *.orig).
//
// vsomeip checks a request in the serving process, against that process's
// own policy file (/etc/vsomeip/<uid>_<gid>/vsomeip_security.json). carsim
// runs as root: root's file has to let the HMI, MainApp, the apps (and anyone
// local) request the stand-in services; the HMI's file has to let root call
// its HmiTest.
//
// How the unit's vsomeip matches a client (found by trying, as uid 5000,
// 12201 and 12203 against carsim's Vehicle):
// - a uid / gid range counts only with numbers ({first: '0', ...} as
//   strings matches nobody, silently: "Isn't allowed to communicate ...
//   Skip!");
// - a client whose uid / gid pair has a policy of its own anywhere in
//   /etc/vsomeip is judged by that pair's policies only, never by a range:
//   such pairs (the HMI's 5000/5000, MainApp's 12201/12201, ...) get an
//   entry of their own here.
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
var fs = require('fs');
var path = require('path');

function patch(file, add) {
  var orig = file + '.orig';
  if (!fs.existsSync(orig)) fs.writeFileSync(orig, fs.readFileSync(file));
  var j = JSON.parse(fs.readFileSync(orig, 'utf8'));
  add(j.security.policies);
  fs.writeFileSync(file, JSON.stringify(j, null, 2));
  console.log('policy: ' + file + ' (' + j.security.policies.length + ' policies)');
}

// every uid / gid pair with a policy of its own in the unit's files
function explicitPairs() {
  var pairs = {};
  (function walk(dir) {
    fs.readdirSync(dir).forEach(function (n) {
      var f = path.join(dir, n);
      if (fs.statSync(f).isDirectory()) return walk(f);
      if (!/\.json$/.test(n)) return;
      var src = fs.existsSync(f + '.orig') ? f + '.orig' : f, j;
      try { j = JSON.parse(fs.readFileSync(src, 'utf8')); } catch (e) { return; }
      ((j.security && j.security.policies) || []).forEach(function (p) {
        var c = p.credentials || {};
        if (typeof c.uid === 'string' && typeof c.gid === 'string') pairs[c.uid + ':' + c.gid] = { uid: c.uid, gid: c.gid };
      });
    });
  })('/etc/vsomeip');
  return Object.keys(pairs).map(function (k) { return pairs[k]; });
}

var ANY = { uid: [{ first: 0, last: 65534 }], gid: [{ first: 0, last: 65534 }] };
// Lifecycle, Monitor, VehicleCondition, Key, Vehicle, FrontCCU (carsim.js)
var CARSIM = ['0xb015', '0xfa61', '0x1531', '0x5535', '0xb510', '0xb508'];
var requests = CARSIM.map(function (s) { return { service: s, instance: 'any' }; });

patch('/etc/vsomeip/0_0/vsomeip_security.json', function (p) {
  explicitPairs().forEach(function (c) { p.unshift({ credentials: c, allow: { requests: requests } }); });
  p.unshift({ credentials: ANY, allow: { requests: requests } });
});
patch('/etc/vsomeip/5000_5000/vsomeip_security.json', function (p) {
  p.push({ credentials: { uid: '0', gid: '0' }, allow: { requests: [{ service: '0xb066', instance: 'any' }] } });
});
