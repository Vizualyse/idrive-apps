// unfallback.js FALLBACK_BUILD_JS MAIN_JS: turn the car's MainApp main.js back into the stock one.
//
// On the car, mgu-store's deploy tool bind-mounts a "fallback copy" of MainApp's
// main.js over /usr/lib/oap-mainapp/src/main.js, so a pull of / reads the copy, not
// the stock bundle. The copy is the stock file plus a few snippets that
// fallback_build.js inserts (the provisioning hook, its helper class, the in-place
// install hook, our apps first in the install queue). Given the fallback_build.js
// the car ran, this removes exactly those snippets, then proves the result: built
// again by that same fallback_build.js it must give the car's file byte for byte.
// Only then is MAIN_JS replaced. A file without the fallback is left as it is.
// The Store's installer refuses a main.js that already carries the fallback.
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
var fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');

var fbFile = process.argv[2], mainFile = process.argv[3];
if (!fbFile || !mainFile) { console.error('usage: node unfallback.js <fallback_build.js> <main.js>'); process.exit(2); }

var car = fs.readFileSync(mainFile, 'utf8');
var MARKS = ['/* mgu-deploy provisioning fallback */', '/* mgu-deploy in-place install */', '/* mgu-deploy apps first */'];
if (!MARKS.some(function (m) { return car.indexOf(m) >= 0; })) { console.log('unfallback: main.js is stock'); process.exit(0); }

// fallback_build.js as a module (it runs main() when loaded)
var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unfallback-'));
var mod = path.join(tmp, 'fb.js');
fs.writeFileSync(mod, fs.readFileSync(fbFile, 'utf8').replace(/\ntry \{\s*process\.exit\(main\(\)\);[\s\S]*$/, '\n') +
    '\nmodule.exports = { HOOK, helperSource, inplaceSource, firstSources, ID7, ID7_NO_CONTROLLER };\n');
var fb = require(mod);

// its defaults, as the deploy tool runs it on the unit
var listPath = '/var/opt/public/oap/oap_12201/data/custom_apps.json';
var requestPath = '/var/opt/mgu-deploy/inplace/request.json';
var statusPath = path.posix.join(path.posix.dirname(listPath), 'mgu-deploy-inplace.json');
var first = fb.firstSources(listPath);
var snippets = [fb.HOOK, fb.helperSource(listPath),
    fb.inplaceSource(requestPath, statusPath, car.indexOf('class AppManagementController{') >= 0 ? fb.ID7 : fb.ID7_NO_CONTROLLER),
    first.queue, first.controller];

var stock = car;
snippets.forEach(function (s, i) {
    var n = stock.split(s).length - 1;
    if (n !== 1) { console.error('unfallback: snippet ' + i + ' found ' + n + ' times: another fallback_build.js version'); process.exit(1); }
    stock = stock.replace(s, function () { return ''; });
});

var stockFile = path.join(tmp, 'stock.js'), again = path.join(tmp, 'again.js');
fs.writeFileSync(stockFile, stock);
cp.execFileSync(process.execPath, [fbFile, stockFile, again], { stdio: 'ignore' });
if (fs.readFileSync(again, 'utf8') !== car) { console.error('unfallback: the rebuilt copy differs from the car file'); process.exit(1); }
fs.writeFileSync(mainFile, stock);
console.log('unfallback: main.js is stock again (' + (car.length - stock.length) + ' bytes of fallback removed, rebuild verified)');
