// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Builds a theme from a design (DESIGNS.md): themes/<id>/design.html, a
 * 1920 x 720 page whose marked elements become the theme's layers and
 * whose bindings become its logic.
 *
 *   node tools/design_build.js themes/<id> [--chrome PATH] [--no-build] [--keep]
 *
 * writes, beside the design (generated: edit the design, not these):
 *   theme.src.json      the layers, paths, fonts and numbers (tools/theme_build.js's input)
 *   art.html            the design with every marked part hidden
 *   sprite.<name>.png   each sprite, cropped, over the art under it
 *   logic.js            the bindings compiled, with logic.extra.js inlined
 * then runs tools/theme_build.js on it (unless --no-build).
 *
 * How: the design is opened once in headless Chrome with a measuring script
 * (--dump-dom hands its result back): each marked element's real on-screen
 * geometry (a gauge's path sampled with getPointAtLength through
 * getScreenCTM; a text's font, size, colour and anchor; boxes), the
 * fonts' advances and ink, the :root colours and the @font-faces. The
 * bindings are compiled into logic.js; the logic is run over the bench
 * drives to find every character each text can show, which sizes the
 * text layers and picks the glyphs of each font's atlas.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');
const { spawnSync } = require('child_process');
const { readPng, writePng } = require('../src/png.js');
const { measure } = require('./field.js');
const DR = require('./design_runtime.js');
const core = require('../src/theme_core.js');
const sim = require('../src/sim.js');

const CHROMES = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'];
const W = 1920;
const KINDS = ['gauge', 'text', 'leds', 'rect', 'sprite', 'map'];
/* characters whose advances the measuring page takes (what a text may show) */
const CANDIDATES = (() => {
    let s = '';
    for (let c = 32; c < 127; c++) s += String.fromCharCode(c);
    return s + '°–—·×±€£\u2002\u2003\u2009';
})();

function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; }
function chrome() {
    const c = [arg('--chrome')].concat(CHROMES).filter((p) => p && fs.existsSync(p))[0];
    if (!c) throw new Error('no Chrome or Edge found (CHROME=... or --chrome)');
    return c;
}
const fileUrl = (f) => 'file:///' + path.resolve(f).replace(/\\/g, '/');

class DesignError extends Error {}
/* an error about an element: names it and its line in design.html */
let SOURCE = '';
function where(e) {
    const needle = 'data-' + e.kind + '="' + e.name + '"';
    const i = SOURCE.indexOf(needle);
    const line = i < 0 ? 'made by a script' : 'design.html line ' + (SOURCE.slice(0, i).split('\n').length);
    return e.desc + ' (' + line + ')';
}
function fail(e, msg) { throw new DesignError(where(e) + ': ' + msg); }

/* ---------------------------------------------------------------- Chrome */

function chromeArgs(tmp, h) {
    return ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--force-color-profile=srgb',
        '--default-background-color=000000ff', '--virtual-time-budget=6000', '--allow-file-access-from-files',
        '--user-data-dir=' + path.join(tmp, 'profile'), '--window-size=' + W + ',' + h];
}

/* the page's DOM after its scripts and ours ran */
function dumpDom(htmlFile, h, tmp) {
    const r = spawnSync(chrome(), chromeArgs(tmp, h).concat(['--dump-dom', fileUrl(htmlFile)]),
        { encoding: 'utf8', timeout: 120000, maxBuffer: 256 * 1024 * 1024 });
    return r.stdout || '';
}

function screenshot(htmlFile, h, tmp) {
    const png = path.join(tmp, 'shot-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.png');
    const r = spawnSync(chrome(), chromeArgs(tmp, h).concat(['--screenshot=' + png, fileUrl(htmlFile)]), { encoding: 'utf8', timeout: 120000 });
    if (!fs.existsSync(png)) throw new Error('screenshot failed: ' + (r.stderr || r.error || '').toString().slice(-400));
    const img = readPng(fs.readFileSync(png));
    if (img.w !== W || img.h < h) throw new Error('screenshot is ' + img.w + 'x' + img.h + ', wanted ' + W + 'x' + h);
    return img;
}

/* the design's source with something added in its head (a style) or at its end (a script) */
function withHead(src, add) {
    if (/<\/head>/i.test(src)) return src.replace(/<\/head>/i, add + '\n</head>');
    if (/<!doctype[^>]*>/i.test(src)) return src.replace(/<!doctype[^>]*>/i, (m) => m + '\n' + add);
    return add + '\n' + src;
}
function withEnd(src, add) {
    if (/<\/body>/i.test(src)) return src.replace(/<\/body>(?![\s\S]*<\/body>)/i, add + '\n</body>');
    return src + '\n' + add;
}

/* What the art leaves out: every marked part (a kept gauge path and the map
 * slot stay), and guides. */
function hideCss(exceptSprite) {
    const sel = ['[data-gauge]:not([data-keep])', '[data-text]', '[data-leds]', '[data-rect]', '[data-guide]',
        exceptSprite ? '[data-sprite]:not([data-sprite="' + exceptSprite + '"])' : '[data-sprite]'];
    return '<style data-design-build>' + sel.map((s) => s + ', ' + s + ' *').join(',\n') + ' { visibility: hidden !important; }</style>';
}

/* ------------------------------------------------- the measuring script */

/* Runs in the design page (Chrome): everything the build needs, as JSON. */
function pageMeasure(o) {
    function done(r) {
        const pre = document.createElement('pre');
        pre.id = '__design_out';
        pre.textContent = btoa(unescape(encodeURIComponent(JSON.stringify(r))));
        document.documentElement.appendChild(pre);
    }
    function scaleOf(e) {
        const m = e.getScreenCTM ? e.getScreenCTM() : null;
        return m ? Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) : 1;
    }
    function opacity(e) {
        let a = 1;
        for (let n = e; n && n.nodeType === 1; n = n.parentNode) { const v = parseFloat(getComputedStyle(n).opacity); if (!isNaN(v)) a *= v; }
        return a;
    }
    function attrs(e) {
        const r = {};
        for (let i = 0; i < e.attributes.length; i++) { const a = e.attributes[i]; if (a.name.indexOf('data-') === 0) r[a.name.slice(5)] = a.value; }
        return r;
    }
    function box(e) { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }
    function collect() {
        const out = { metas: {}, params: null, colors: {}, faces: [], elements: [], fonts: {}, art: [] };
        document.querySelectorAll('meta[name]').forEach((m) => { out.metas[m.getAttribute('name')] = m.getAttribute('content'); });
        const pe = document.querySelector('script#theme-params');
        if (pe) out.params = pe.textContent;
        /* :root colours and @font-faces */
        const probe = document.createElement('div');
        document.body.appendChild(probe);
        const rootCs = getComputedStyle(document.documentElement);
        for (let s = 0; s < document.styleSheets.length; s++) {
            let rules = [];
            try { rules = document.styleSheets[s].cssRules; } catch (e) { continue; }
            for (let i = 0; i < rules.length; i++) {
                const r = rules[i];
                if (r.type === 5) {
                    const src = r.style.getPropertyValue('src'), m = /url\(\s*["']?([^"')]+)/.exec(src);
                    if (m) out.faces.push({ family: r.style.getPropertyValue('font-family').replace(/["']/g, '').trim(),
                        weight: r.style.getPropertyValue('font-weight') || '400',
                        url: new URL(m[1], r.parentStyleSheet.href || document.baseURI).href });
                } else if (r.type === 1 && /(^|,)\s*(:root|html)\s*(,|$)/.test(r.selectorText)) {
                    for (let k = 0; k < r.style.length; k++) {
                        const name = r.style[k];
                        if (name.indexOf('--') !== 0) continue;
                        const v = rootCs.getPropertyValue(name).trim();
                        probe.style.color = '';
                        probe.style.color = v;
                        if (probe.style.color) out.colors[name.slice(2)] = getComputedStyle(probe).color;
                    }
                }
            }
        }
        probe.remove();

        const sel = o.kinds.map((k) => '[data-' + k + ']').join(',');
        const marked = Array.prototype.slice.call(document.querySelectorAll(sel));
        const fontKeys = {};
        marked.forEach((e, index) => {
            const a = attrs(e);
            const kinds = o.kinds.filter((k) => a[k] !== undefined);
            const kind = kinds[0], name = a[kind];
            const tag = e.tagName.toLowerCase();
            const rec = { index, kind, kinds, name, tag, attrs: a, svg: e instanceof SVGElement,
                desc: '<' + tag + ' data-' + kind + '="' + name + '"' + (e.id ? ' id="' + e.id + '"' : '') + '>',
                inside: marked.filter((p) => p !== e && p.contains(e)).map((p) => p.tagName.toLowerCase() + ' ' + Object.keys(attrs(p)).filter((k) => o.kinds.indexOf(k) >= 0).join(' ')),
                box: box(e), opacity: opacity(e) };
            const cs = getComputedStyle(e);
            rec.fill = cs.fill; rec.stroke = cs.stroke; rec.color = cs.color; rec.background = cs.backgroundColor;
            rec.fillOpacity = parseFloat(cs.fillOpacity); rec.strokeOpacity = parseFloat(cs.strokeOpacity);
            rec.scale = rec.svg ? scaleOf(e) : 1;
            rec.strokeWidth = cs.stroke !== 'none' ? parseFloat(cs.strokeWidth) * rec.scale : 0;
            if (tag === 'rect') rec.rx = (parseFloat(e.getAttribute('rx')) || parseFloat(e.getAttribute('ry')) || 0) * rec.scale;
            else if (tag === 'circle') rec.rx = parseFloat(e.getAttribute('r')) * rec.scale;
            else if (!rec.svg) rec.rx = parseFloat(cs.borderTopLeftRadius) || 0;
            if (kind === 'gauge') {
                if (!(e instanceof SVGGeometryElement)) rec.error = 'a gauge must be an SVG path, line, polyline, circle or other shape';
                else {
                    const L = e.getTotalLength(), n = Math.max(2, Math.ceil(L / o.step)), m = e.getScreenCTM();
                    const pts = [];
                    for (let i = 0; i <= n; i++) {
                        const p = e.getPointAtLength(L * i / n), q = new DOMPoint(p.x, p.y).matrixTransform(m);
                        pts.push([q.x, q.y]);
                    }
                    rec.points = pts;
                }
            }
            if (kind === 'text') {
                const family = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
                const size = parseFloat(cs.fontSize) * rec.scale;
                const tracking = cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing) * rec.scale;
                const proportional = !/tabular-nums/.test(cs.fontVariantNumeric);
                const key = [family, cs.fontWeight, Math.round(size * 100) / 100, Math.round(tracking * 100) / 100, proportional ? 'p' : 't'].join('|');
                rec.font = { key, family, weight: cs.fontWeight, size, tracking, proportional };
                fontKeys[key] = rec.font;
                rec.placeholder = e.textContent.trim();
                rec.textColor = rec.svg ? cs.fill : cs.color;
                if (rec.svg) {
                    const n = e.getNumberOfChars();
                    if (!n) rec.error = 'a text needs placeholder text (the design shows it; its anchor is measured from it)';
                    else {
                        const m = e.getScreenCTM();
                        const sp = e.getStartPositionOfChar(0), ep = e.getEndPositionOfChar(n - 1);
                        const s = new DOMPoint(sp.x, sp.y).matrixTransform(m), en = new DOMPoint(ep.x, ep.y).matrixTransform(m);
                        const anchor = cs.textAnchor;
                        rec.align = anchor === 'end' ? 'right' : anchor === 'middle' ? 'center' : 'left';
                        rec.anchorX = anchor === 'end' ? en.x : anchor === 'middle' ? (s.x + en.x) / 2 : s.x;
                        rec.baseline = s.y;
                    }
                } else {
                    const r = e.getBoundingClientRect();
                    const ta = cs.textAlign;
                    rec.align = /right|end/.test(ta) ? 'right' : ta === 'center' ? 'center' : 'left';
                    rec.anchorX = rec.align === 'right' ? r.right - parseFloat(cs.paddingRight) : rec.align === 'center' ? (r.left + r.right) / 2 : r.left + parseFloat(cs.paddingLeft);
                    const mk = document.createElement('span');
                    mk.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
                    e.appendChild(mk);
                    rec.baseline = mk.getBoundingClientRect().top;
                    mk.remove();
                }
            }
            out.elements.push(rec);
        });

        /* each font: advances (as theme_build's atlas page measures them), ink, baseline */
        const cv = document.createElement('canvas').getContext('2d');
        Object.keys(fontKeys).forEach((key) => {
            const f = fontKeys[key];
            const css = 'position:absolute;left:0;top:0;white-space:pre;visibility:hidden;font-family:"' + f.family + '";font-weight:' + f.weight +
                ';font-size:' + f.size + 'px;letter-spacing:' + f.tracking + 'px;font-variant-numeric:' + (f.proportional ? 'proportional-nums' : 'tabular-nums');
            const host = document.createElement('div');
            host.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;overflow:hidden';
            document.body.appendChild(host);
            const adv = {}, ink = {};
            cv.font = f.weight + ' ' + f.size + 'px "' + f.family + '"';
            const chars = o.candidates + (o.extra[key] || '');
            for (let i = 0; i < chars.length; i++) {
                const c = chars[i];
                if (adv[c] !== undefined) continue;
                const s = document.createElement('span');
                s.style.cssText = css;
                s.textContent = c;
                host.appendChild(s);
                adv[c] = s.getBoundingClientRect().width;
                const m = cv.measureText(c);
                ink[c] = [m.actualBoundingBoxAscent, m.actualBoundingBoxDescent, m.actualBoundingBoxRight];
            }
            const line = document.createElement('div');
            line.style.cssText = css.replace('white-space:pre', 'white-space:pre;line-height:100px;height:100px');
            line.textContent = 'x';
            const mk = document.createElement('span');
            mk.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
            line.appendChild(mk);
            host.appendChild(line);
            const base100 = mk.getBoundingClientRect().top - line.getBoundingClientRect().top;
            let loaded = false;
            document.fonts.forEach((ff) => { if (ff.family.replace(/["']/g, '') === f.family && ff.status === 'loaded') loaded = true; });
            out.fonts[key] = Object.assign({}, f, { adv, ink, base100, loaded });
            host.remove();
        });

        /* unmarked art reaching into the top keep-clear zone */
        const skip = 'defs, mask, clipPath, pattern, marker, linearGradient, radialGradient, filter, symbol, script, style, [data-bleed], ' + sel + ', [data-guide]';
        document.querySelectorAll('svg *, body *').forEach((e) => {
            if (e.closest(skip) || e.id === '__design_out') return;
            if (e instanceof SVGElement ? (e instanceof SVGGElement || e instanceof SVGSVGElement || !(e instanceof SVGGraphicsElement)) : e.children.length) return;
            const cs = getComputedStyle(e);
            if (cs.visibility === 'hidden' || cs.display === 'none') return;
            const r = e.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) return;
            if (r.width >= 1500 || r.height >= 500) return;   /* backgrounds and washes */
            if (r.top < o.safeTop && r.bottom > 0) out.art.push('<' + e.tagName.toLowerCase() + (e.id ? ' id="' + e.id + '"' : '') + (e.getAttribute('class') ? ' class="' + e.getAttribute('class') + '"' : '') + '> at y ' + Math.round(r.top));
        });
        return out;
    }
    window.addEventListener('load', () => {
        document.fonts.ready.then(() => setTimeout(() => {
            try { done(collect()); } catch (e) { done({ error: String((e && e.stack) || e) }); }
        }, 50));
    });
}

function runMeasure(src, srcHtml, safeTop, bottom, extra, tmp) {
    const opts = { kinds: KINDS, step: 2, candidates: CANDIDATES, safeTop, extra };
    /* beside the design: Chrome loads file:// fonts only from the page's own folder tree */
    const page = withEnd(srcHtml, '<script>(' + pageMeasure.toString() + ')(' + JSON.stringify(opts) + ');</script>');
    const file = path.join(src, '.measure.html');
    fs.writeFileSync(file, page);
    let dom;
    try { dom = dumpDom(file, bottom, tmp); } finally { fs.unlinkSync(file); }
    const m = /<pre id="__design_out">([^<]*)<\/pre>/.exec(dom);
    if (!m) throw new Error('the design did not finish loading in Chrome (no measurement came back)');
    const r = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
    if (r.error) throw new Error('measuring the design failed: ' + r.error);
    return r;
}

/* ------------------------------------------------------------ bindings */

const SIGNALS = (() => {
    const s = { source: true };
    [sim.at(0), sim.at(0, 'comfort')].forEach((f) => Object.keys(f).forEach((k) => { s[k] = true; }));
    return Object.keys(s);
})();
const GLOBALS = ['C', 'P', 't', 'dt', 'Math', 'true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'typeof', 'instanceof',
    'new', 'in', 'void', 'String', 'Number', 'isFinite', 'parseInt', 'parseFloat'];

/* the identifiers an expression reads (not property names, strings or regexes) */
function identifiers(js) {
    const ids = [];
    let i = 0, prev = '';
    while (i < js.length) {
        const c = js[i];
        if (c === '"' || c === "'" || c === '`') {
            let j = i + 1;
            while (j < js.length && js[j] !== c) j += js[j] === '\\' ? 2 : 1;
            i = j + 1; prev = 'v'; continue;
        }
        if (c === '/' && (prev === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev))) {
            let j = i + 1, cls = false;
            while (j < js.length && (js[j] !== '/' || cls)) { if (js[j] === '\\') j++; else if (js[j] === '[') cls = true; else if (js[j] === ']') cls = false; j++; }
            j++;
            while (j < js.length && /[a-z]/i.test(js[j])) j++;
            i = j; prev = 'v'; continue;
        }
        if (/[A-Za-z_$]/.test(c)) {
            let j = i;
            while (j < js.length && /[\w$]/.test(js[j])) j++;
            const id = js.slice(i, j);
            if (prev !== '.') ids.push(id);
            i = j; prev = 'v'; continue;
        }
        if (/\d/.test(c)) { while (i < js.length && /[\w.]/.test(js[i])) i++; prev = 'v'; continue; }
        if (!/\s/.test(c)) prev = c === ')' || c === ']' ? 'v' : c;
        i++;
    }
    return ids;
}

/* CSS colours written bare in an expression: #rrggbb and var(--name) */
function preprocess(src) {
    return src.replace(/var\(\s*--([\w-]+)\s*\)/g, (m, n) => 'C[' + JSON.stringify(n) + ']')
        .replace(/(^|[^\w'"&])#([0-9a-fA-F]{3,8})(?![\w])/g, (m, a, h) => a + "'#" + h + "'");
}

function Compiler(colors, params) {
    this.colors = colors; this.params = params;
    this.lets = [];       /* [{ name, js, id }] */
    this.signals = {};
    this.n = 0;
}
/* an expression as a function source (S signals, H helpers, L lets), what it
 * reads and whether it is a constant (evaluated here) */
Compiler.prototype.compile = function (src, el, attr) {
    const js = preprocess(String(src).trim());
    const ids = identifiers(js);
    const letNames = this.lets.map((l) => l.name);
    const known = SIGNALS.concat(letNames, DR.NAMES, GLOBALS);
    const unknown = ids.filter((x) => known.indexOf(x) < 0);
    const what = el ? where(el) + ' data-' + attr : 'let ' + attr;
    if (unknown.length) throw new DesignError(what + '="' + src + '": unknown name ' + unknown[0] +
        ' (signals: ' + SIGNALS.join(', ') + '; helpers: ' + DR.NAMES.join(', ') + (letNames.length ? '; lets: ' + letNames.join(', ') : '') + ')');
    const uniq = (a) => a.filter((x, i) => a.indexOf(x) === i);
    const sigs = uniq(ids.filter((x) => SIGNALS.indexOf(x) >= 0));
    const lets = uniq(ids.filter((x) => letNames.indexOf(x) >= 0));
    const helpers = uniq(ids.filter((x) => DR.NAMES.indexOf(x) >= 0));
    sigs.forEach((s) => { this.signals[s] = true; });
    /* a let's signals count as the expression's own */
    lets.forEach((l) => { this.lets.filter((x) => x.name === l)[0].sigs.forEach((s) => sigs.indexOf(s) < 0 && sigs.push(s)); });
    const decl = [];
    sigs.filter((s) => ids.indexOf(s) >= 0).forEach((s) => decl.push(s + ' = S.' + s));
    lets.forEach((l) => decl.push(l + ' = L.' + l));
    helpers.forEach((h) => decl.push(h + ' = H.' + h));
    if (ids.indexOf('t') >= 0) decl.push('t = H._t()');
    if (ids.indexOf('dt') >= 0) decl.push('dt = H._dt()');
    const body = (decl.length ? 'var ' + decl.join(', ') + '; ' : '') + 'return (' + js + ');';
    let fn;
    try { fn = new Function('S', 'H', 'L', 'C', 'P', body); } catch (e) { throw new DesignError(what + '="' + src + '": ' + e.message); }
    const constant = !sigs.length && !lets.length && !helpers.some((h) => DR.STATEFUL.indexOf(h) >= 0) &&
        ids.indexOf('t') < 0 && ids.indexOf('dt') < 0;
    const r = { src, source: 'function (S, H, L) { ' + body + ' }', sigs, constant, id: 'b' + (this.n++) };
    if (constant) {
        const B = { slots: [], i: 0, dt: 0, ctx: { t: 0, dt: 0 } };
        try { r.value = fn({}, DR.makeHelpers(B, core), {}, this.colors, this.params); } catch (e) { throw new DesignError(what + '="' + src + '": ' + e.message); }
    }
    return r;
};
Compiler.prototype.addLet = function (name, src) {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new DesignError('<meta name="let:' + name + '">: not a name');
    if (SIGNALS.concat(DR.NAMES, GLOBALS, this.lets.map((l) => l.name)).indexOf(name) >= 0) throw new DesignError('<meta name="let:' + name + '">: ' + name + ' is taken (a signal, a helper or another let)');
    const c = this.compile(src, null, name);
    this.lets.push({ name, source: c.source, id: c.id, sigs: c.sigs });
};

/* ------------------------------------------------------------- helpers */

const R2 = (v) => Math.round(v * 100) / 100;
const nums = (s, n, e, attr) => {
    if (s == null) return null;
    const a = String(s).trim().split(/[\s,]+/).map(Number);
    if (a.some((x) => !isFinite(x)) || (n && a.length < n)) fail(e, 'data-' + attr + '="' + s + '": wants ' + (n || 'some') + ' numbers');
    return a;
};
function cssColor(s, opacity) {
    if (!s || s === 'none' || /^url\(/.test(s)) return null;
    const c = DR.col(s);
    if (!c) return null;
    const r4 = (x) => Math.round(x * 10000) / 10000;
    return [r4(c[0]), r4(c[1]), r4(c[2]), r4(c[3] * (opacity == null ? 1 : opacity))];
}
const round4 = (c) => c.map((x) => Math.round(x * 10000) / 10000);

/* a polyline, simplified (Ramer-Douglas-Peucker), as field.js pieces */
function simplify(pts, eps) {
    if (pts.length < 3) return pts;
    const keep = new Array(pts.length).fill(false);
    keep[0] = keep[pts.length - 1] = true;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
        const [a, b] = stack.pop();
        const [ax, ay] = pts[a], dx = pts[b][0] - ax, dy = pts[b][1] - ay, l = Math.hypot(dx, dy) || 1;
        let best = -1, bi = -1;
        for (let i = a + 1; i < b; i++) {
            const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / l;
            if (d > best) { best = d; bi = i; }
        }
        if (best > eps) { keep[bi] = true; stack.push([a, bi], [bi, b]); }
    }
    return pts.filter((p, i) => keep[i]);
}
/* n + 1 points at equal fractions of a polyline's length */
function resample(pts, n) {
    const cum = measure(pts), total = cum[cum.length - 1], out = [];
    let j = 0;
    for (let i = 0; i <= n; i++) {
        const s = total * i / n;
        while (j < cum.length - 2 && cum[j + 1] < s) j++;
        const k = cum[j + 1] > cum[j] ? (s - cum[j]) / (cum[j + 1] - cum[j]) : 0;
        out.push([pts[j][0] + (pts[j + 1][0] - pts[j][0]) * k, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * k]);
    }
    return out;
}
/* left-of-travel unit normals (screen, y down) at each point */
function normals(pts) {
    return pts.map((p, i) => {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
        return [dy / l, -dx / l];
    });
}

/* ---------------------------------------------------------------- build */

function designBuild(srcDir) {
    const src = path.resolve(srcDir);
    const designFile = path.join(src, 'design.html');
    if (!fs.existsSync(designFile)) throw new DesignError('no design.html in ' + src);
    SOURCE = fs.readFileSync(designFile, 'utf8');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-'));
    const metaRe = (n) => { const m = new RegExp('<meta\\s+name="' + n + '"\\s+content="([^"]*)"', 'i').exec(SOURCE); return m ? m[1] : null; };
    const bottom = Number(metaRe('theme-bottom') || 720);
    const safeTop = Number(metaRe('safe-top') || 40);
    if (!(bottom >= core.LIMITS.bottom && bottom <= 720)) throw new DesignError('<meta name="theme-bottom">: ' + bottom + ' (646..720)');

    /* glyphs a text asks for by hand (data-glyphs) are measured too */
    const extra = {};
    let M = runMeasure(src, SOURCE, safeTop, bottom, extra, tmp);
    const wantExtra = {};
    M.elements.filter((e) => e.kind === 'text' && e.attrs.glyphs).forEach((e) => { wantExtra[e.font.key] = (wantExtra[e.font.key] || '') + e.attrs.glyphs; });
    if (Object.keys(wantExtra).some((k) => wantExtra[k].split('').some((c) => CANDIDATES.indexOf(c) < 0))) M = runMeasure(src, SOURCE, safeTop, bottom, wantExtra, tmp);

    const id = M.metas['theme-id'] || path.basename(src);
    if (!/^[a-z0-9]+$/.test(id)) throw new DesignError('theme id "' + id + '" must be [a-z0-9]+');
    let params = {};
    if (M.params) { try { params = JSON.parse(M.params); } catch (e) { throw new DesignError('<script id="theme-params">: ' + e.message); } }
    const colors = {};
    Object.keys(M.colors).forEach((k) => {
        const c = cssColor(M.colors[k]);
        if (!c) return;
        colors[k] = c;
        const camel = k.replace(/-(\w)/g, (m, a) => a.toUpperCase());
        if (camel !== k) colors[camel] = c;
    });
    const comp = new Compiler(colors, params);
    Object.keys(M.metas).filter((k) => /^let:/.test(k)).forEach((k) => comp.addLet(k.slice(4), M.metas[k]));
    const warnings = [];

    /* the elements: checks that need nothing else */
    const els = M.elements;
    const names = {};
    let map = null;
    els.forEach((e) => {
        if (e.error) fail(e, e.error);
        if (e.kinds.length > 1) fail(e, 'one marker an element (it has ' + e.kinds.map((k) => 'data-' + k).join(', ') + ')');
        if (e.kind === 'map') {
            if (map) fail(e, 'a theme has at most one map slot');
            const b = e.box;
            map = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h), radius: Math.round(e.rx || 0) };
            if (map.x < 0 || map.y < 0 || map.x + map.w > W || map.y + map.h > bottom) fail(e, 'the map slot is outside the panel');
            return;
        }
        if (!/^[A-Za-z][A-Za-z0-9]*$/.test(e.name)) fail(e, 'a layer name is letters and digits, starting with a letter');
        if (e.name === 'art') fail(e, '"art" is the static art\'s layer');
        if (names[e.name]) fail(e, 'two layers named ' + e.name);
        names[e.name] = e;
        if (e.inside.length) fail(e, 'sits inside another marked element (' + e.inside[0] + '): marked elements do not nest');
    });
    const layersEls = els.filter((e) => e.kind !== 'map');
    if (layersEls.length + 1 > core.LIMITS.layers) throw new DesignError(layersEls.length + ' marked elements and the art make ' + (layersEls.length + 1) +
        ' layers (at most ' + core.LIMITS.layers + '); the last over the limit is ' + where(layersEls[core.LIMITS.layers - 1]));
    if (M.art.length) warnings.push('art in the top ' + safeTop + ' px keep-clear zone (mark it data-bleed if meant): ' + M.art.slice(0, 6).join(', ') + (M.art.length > 6 ? ', ...' : ''));

    const inPanel = (e, r, what) => {
        if (r.x < 0 || r.x + r.w > W) fail(e, (what || 'it') + ' reaches x ' + Math.round(r.x < 0 ? r.x : r.x + r.w) + ' (the panel is 0..' + W + ')');
        if (r.y + r.h > bottom) fail(e, (what || 'it') + ' reaches y ' + Math.round(r.y + r.h) + ' (the theme ends at ' + bottom + ')');
        if (r.y < 0) fail(e, (what || 'it') + ' starts above the panel (y ' + Math.round(r.y) + ')');
    };
    const safe = (e, y, what) => { if (y < safeTop) fail(e, (what || 'it') + ' starts at y ' + Math.round(y) + ', inside the top keep-clear zone (' + safeTop + ' px, <meta name="safe-top">)'); };

    /* a binding attribute: { constant value } or { a compiled expression } */
    const bind = (e, attr) => (e.attrs[attr] == null || e.attrs[attr] === '' ? null : comp.compile(e.attrs[attr], e, attr));
    const constColor = (e, attr, b, fallback) => {
        if (!b) return fallback;
        if (!b.constant) return fallback;
        const c = DR.col(b.value);
        if (!c) fail(e, 'data-' + attr + '="' + b.src + '" is not a colour');
        return round4(c);
    };

    const spec = { id, title: M.metas['theme-title'] || id, family: M.metas['theme-family'] || id, mode: M.metas['theme-mode'] || 'sport',
        version: 2, ship: !/^(false|no|0)$/i.test(M.metas['theme-ship'] || 'true'), bottom, art: 'art.html',
        signals: [], params: Object.assign({}, params, { design: { safeTop } }), fonts: {}, paths: {}, layers: [] };
    if (map) spec.map = map;
    const logicLayers = [];   /* what logic.js evaluates per layer */
    const gauges = {};

    layersEls.forEach((e) => {
        const L = { name: e.name, kind: e.kind, b: {}, x: 0, y: 0 };
        const common = () => {
            ['show', 'dx', 'dy'].forEach((k) => { const b = bind(e, k); if (b) L.b[k] = b; });
            if (e.attrs.rate) { L.rate = Number(e.attrs.rate); if (!(L.rate > 0 && L.rate <= 25)) fail(e, 'data-rate is 0..25 times a second'); }
        };
        const opacity = e.opacity;
        if (e.kind === 'gauge') {
            let pts = e.points;
            const cum = measure(pts), len = cum[cum.length - 1];
            const start = Number(e.attrs.start || 0), end = Number(e.attrs.end || 0);
            if (!(start >= 0 && end >= 0 && start + end < len)) fail(e, 'data-start ' + start + ' and data-end ' + end + ' px leave nothing of a ' + Math.round(len) + ' px path');
            const t0 = start / len, t1 = 1 - end / len;
            const strokeCol = cssColor(e.stroke, opacity * (isNaN(e.strokeOpacity) ? 1 : e.strokeOpacity));
            const band = nums(e.attrs.band, 2, e, 'band') || (strokeCol && e.strokeWidth ? [-e.strokeWidth / 2, e.strokeWidth / 2] : [0, 0]);
            const needle = nums(e.attrs.needle, 3, e, 'needle');
            const glow = nums(e.attrs.glow, 1, e, 'glow');
            const pool = nums(e.attrs.pool, 3, e, 'pool');
            const look = nums(e.attrs.look, 3, e, 'look') || [0.25, 0, 2];
            const segs = nums(e.attrs.segments, 2, e, 'segments');
            const red = e.attrs.red != null ? Number(e.attrs.red) : null;
            const bValue = bind(e, 'value'), bFrom = bind(e, 'from');
            const bands = { 'band-color': 'color', 'needle-color': 'needle', 'glow-color': 'glow', 'red-color': 'red' };
            const bc = {};
            Object.keys(bands).forEach((k) => { bc[k] = bind(e, k); });
            const fill = constColor(e, 'band-color', bc['band-color'], strokeCol || [0, 0, 0, 0]);
            const from = bFrom && bFrom.constant ? Number(bFrom.value) : 0;
            const tAt = (k) => t0 + Math.max(0, Math.min(1, k)) * (t1 - t0);
            const uniforms = {
                u_val: [R2(tAt(from) * 1e4) / 1e4, 0, red != null ? Math.round(tAt(red) * 1e5) / 1e5 : 2, glow && glow[1] ? Math.round(glow[1] / len * 1e5) / 1e5 : 0],
                u_band: [band[0], band[1], needle ? needle[0] : 0, needle ? needle[1] : 0],
                u_shape: [glow ? glow[0] : 1, needle ? needle[2] / 2 : 0, needle ? (needle[3] != null ? needle[3] : needle[2]) / 2 : 0, glow && glow[2] != null ? glow[2] : 0],
                u_fill: fill,
                u_red: constColor(e, 'red-color', bc['red-color'], fill),
                u_glow: constColor(e, 'glow-color', bc['glow-color'], [0, 0, 0, 0]),
                u_needle: constColor(e, 'needle-color', bc['needle-color'], needle ? [1, 1, 1, 1] : [0, 0, 0, 0]),
                u_seg: [segs ? segs[0] : 0, segs ? segs[1] : 0, Math.round(tAt(from) * 1e5) / 1e5, Math.round(t1 * 1e5) / 1e5],
                u_pool: [pool ? pool[0] : 0, pool ? pool[1] : 0, pool ? pool[2] : 0, 0],
                u_look: [look[0], look[1], look[2], 0],
            };
            /* how far from the path the gauge draws, each side */
            const rin = Math.max(band[1], needle ? needle[1] : 0, glow ? glow[0] : 0, pool ? pool[2] + pool[0] : 0, 0);
            const rout = Math.max(-band[0], needle ? -needle[0] : 0, glow ? glow[0] * look[0] : 0, pool ? pool[0] - pool[2] : 0, 0);
            const maxd = e.attrs.maxd ? Number(e.attrs.maxd) : Math.min(127, Math.ceil(Math.max(rin, rout)) + 1);
            if (!(maxd > 0 && maxd <= 127)) fail(e, 'data-maxd is 1..127 px');
            /* inward: left or right of travel; by default the side the shape's middle is on */
            let inward;
            if (e.attrs.inward === 'left') inward = 1;
            else if (e.attrs.inward === 'right') inward = -1;
            else if (e.attrs.inward && e.attrs.inward !== 'auto') fail(e, 'data-inward is left, right or auto');
            else {
                const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
                const cx = (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2, cy = (Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2;
                const ns = normals(pts);
                const vote = pts.reduce((v, p, i) => v + ns[i][0] * (cx - p[0]) + ns[i][1] * (cy - p[1]), 0);
                inward = vote >= 0 ? 1 : -1;
            }
            if (Math.min.apply(null, pts.map((p) => p[1])) < safeTop) safe(e, Math.min.apply(null, pts.map((p) => p[1])), 'its path');
            const lname = e.name;
            const reuse = e.attrs.reuse;
            if (reuse) {
                const o = gauges[reuse];
                if (!o) fail(e, 'data-reuse="' + reuse + '": no gauge ' + reuse + ' before it in the design');
                if (o.reuse) fail(e, 'data-reuse="' + reuse + '": ' + reuse + ' reuses a field itself');
                if (Math.abs(o.len - len) > 2) fail(e, 'data-reuse="' + reuse + '": its path is ' + Math.round(len) + ' px, ' + reuse + '\'s ' + Math.round(o.len) + ' px');
                const a = resample(o.points, 64), b = resample(pts, 64);
                const off = (f) => Math.max.apply(null, a.map((p, i) => Math.hypot(f(p)[0] - b[i][0], f(p)[1] - b[i][1])));
                const dx = b[0][0] - a[0][0], dy = b[0][1] - a[0][1], cx = b[0][0] + a[0][0];
                const tries = [
                    ['mirror', off((p) => [W - p[0], p[1]])],
                    ['copy', off((p) => [p[0] + dx, p[1] + dy])],
                    ['flip', off((p) => [cx - p[0], p[1] + dy])],
                /* the first that fits, in this order (a mirror needs no position) */
                ].sort((x, y) => (x[1] > 1.5) - (y[1] > 1.5) || (x[1] > 1.5 ? x[1] - y[1] : 0));
                if (tries[0][1] > 1.5) fail(e, 'data-reuse="' + reuse + '": its path is not ' + reuse + '\'s mirror image about the middle, a copy moved, or a copy flipped (closest: ' + tries[0][0] + ', ' + tries[0][1].toFixed(1) + ' px off); draw it as one, or drop data-reuse');
                const r = o.rect;
                if (tries[0][0] === 'mirror') spec.paths[lname] = { mirror: reuse };
                else if (tries[0][0] === 'copy') spec.paths[lname] = { copy: reuse, at: [r[0] + Math.round(dx), r[1] + Math.round(dy)] };
                else spec.paths[lname] = { copy: reuse, flip: true, at: [Math.round(cx) - r[0] - r[2], r[1] + Math.round(dy)] };
                const rr = tries[0][0] === 'mirror' ? [W - r[0] - r[2], r[1], r[2], r[3]] : [spec.paths[lname].at[0], spec.paths[lname].at[1], r[2], r[3]];
                inPanel(e, { x: rr[0], y: rr[1], w: rr[2], h: rr[3] }, 'its field');
                if (maxd > o.maxd + 0.5 && e.attrs.maxd == null) warnings.push(where(e) + ': draws up to ' + maxd + ' px from its path, but reuses ' + reuse + '\'s field, which holds ' + o.maxd + ' px');
                gauges[lname] = { reuse, len, rect: rr, art: e.attrs.art };
            } else {
                /* the field's rectangle: every point of the path moved along its
                 * normal from the outward reach to the inward one */
                const ns = normals(pts);
                const ri = Math.min(rin + 1, maxd), ro = Math.min(rout + 1, maxd);
                let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
                const add = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
                pts.forEach((p, i) => { const n = ns[i]; add(p[0] + n[0] * inward * ri, p[1] + n[1] * inward * ri); add(p[0] - n[0] * inward * ro, p[1] - n[1] * inward * ro); add(p[0], p[1]); });
                const ends = e.attrs.ends != null;
                const pad = ends ? maxd : 2;
                const rect = [Math.max(0, Math.floor(x0 - (ends ? pad : 2))), Math.max(0, Math.floor(y0 - (ends ? pad : 2)))];
                rect.push(Math.min(W, Math.ceil(x1 + (ends ? pad : 2))) - rect[0], Math.min(bottom, Math.ceil(y1 + (ends ? pad : 2))) - rect[1]);
                const sp = simplify(pts, 0.05);
                const piece = sp.map((p, i) => [i ? 'L' : 'M', R2(p[0]), R2(p[1])]);
                spec.paths[lname] = { path: piece, inward, rect, maxd };
                if (ends) spec.paths[lname].ends = true;
                gauges[lname] = { len, rect, points: pts, maxd, art: e.attrs.art };
            }
            const layer = { name: lname, shader: 'gauge', field: lname, uniforms };
            if (/^(off|false|no)$/i.test(e.attrs.art || '')) layer.art = false;
            spec.layers.push(layer);
            Object.assign(L, { t0, t1, segs: segs || [0, 0], segEnd: t1 });
            if (bValue) L.b.value = bValue;
            if (bFrom && !bFrom.constant) L.b.from = bFrom;
            Object.keys(bands).forEach((k) => { if (bc[k] && !bc[k].constant) L.b[k] = bc[k]; });
            L.said = bands;
            common();
        } else if (e.kind === 'text') {
            const tb = bind(e, 'text-expr');
            if (!tb) fail(e, 'a text needs data-text-expr (what it shows)');
            const cb = bind(e, 'color');
            const color = constColor(e, 'color', cb, cssColor(e.textColor, opacity * (e.svg && !isNaN(e.fillOpacity) ? e.fillOpacity : 1)) || [1, 1, 1, 1]);
            L.b.text = tb;
            if (cb && !cb.constant) L.b.color = cb;
            L.nullText = e.attrs.null != null ? e.attrs.null : '--';
            L.el = e;
            L.align = e.attrs.align || e.align;
            if (['left', 'right', 'center'].indexOf(L.align) < 0) fail(e, 'data-align is left, right or center');
            L.color = color;
            spec.layers.push({ name: e.name, shader: 'text', font: null, x: 0, y: 0, w: 0, cells: 1, align: L.align, text: '', uniforms: { u_color: color } });
            common();
        } else if (e.kind === 'leds') {
            const b = e.box;
            const x = Math.round(b.x), y = Math.round(b.y), w = Math.round(b.w), h = Math.round(b.h);
            inPanel(e, { x, y, w, h }); safe(e, y);
            const count = Number(e.attrs.count);
            if (!(count >= 1 && count <= 64)) fail(e, 'data-count (how many lights) is 1..64');
            const light = nums(e.attrs.light, 2, e, 'light') || [w / count * 0.8, h * 0.9];
            const split = nums(e.attrs.split, 2, e, 'split') || [99, 99];
            const lean = nums(e.attrs.lean, 1, e, 'lean') || [0, 0, 0];
            const cb = {};
            const u = { u_led: [count, 0, 0, e.attrs.mode === 'ends' ? 1 : 0], u_geom: [0, 0, R2(light[0]), R2(light[1])],
                u_split: [split[0], split[1], Number(e.attrs.radius || 0), Number(e.attrs.halo || 0)], u_lean: [R2(lean[0]), lean[1] || 0, lean[2] || 0, 0] };
            const defaults = { c0: [1, 0.63, 0.2, 1], c1: null, c2: null, off: [0.17, 0.15, 0.14, 1] };
            ['c0', 'c1', 'c2', 'off'].forEach((k) => {
                cb[k] = bind(e, k);
                const fb = defaults[k] || u.u_c0;
                u['u_' + k] = constColor(e, k, cb[k], fb);
                if (cb[k] && !cb[k].constant) L.b['u_' + k] = cb[k];
            });
            if (e.attrs.mode && ['ends', 'fill'].indexOf(e.attrs.mode) < 0) fail(e, 'data-mode is fill or ends');
            ['lit', 'flash'].forEach((k) => { const bb = bind(e, k); if (bb) L.b[k] = bb; });
            if (!L.b.lit) fail(e, 'leds need data-lit (how many steps are lit)');
            spec.layers.push({ name: e.name, shader: 'leds', x, y, w, h, uniforms: u });
            Object.assign(L, { x, y });
            common();
        } else if (e.kind === 'rect') {
            const b = e.box, sw = e.strokeWidth || 0;
            const ringCol = sw ? cssColor(e.stroke, opacity * (isNaN(e.strokeOpacity) ? 1 : e.strokeOpacity)) : null;
            const grow = ringCol && e.svg ? sw / 2 : 0;
            const x = Math.round(b.x - grow), y = Math.round(b.y - grow), w = Math.round(b.w + grow * 2), h = Math.round(b.h + grow * 2);
            inPanel(e, { x, y, w, h }); safe(e, y);
            const fill = e.svg ? cssColor(e.fill, opacity * (isNaN(e.fillOpacity) ? 1 : e.fillOpacity)) : cssColor(e.background, opacity);
            const radius = e.attrs.radius != null ? Number(e.attrs.radius) : e.tag === 'circle' ? Math.min(w, h) / 2 : (e.rx || 0) + grow;
            const ringW = e.attrs.ring != null ? Number(e.attrs.ring) : ringCol ? sw : 0;
            const cb = bind(e, 'color'), rb = bind(e, 'ring-color');
            const u = { u_shape: [0, 0, R2(radius), R2(ringW)], u_color: constColor(e, 'color', cb, fill || [0, 0, 0, 0]),
                u_ring: constColor(e, 'ring-color', rb, ringCol || [0, 0, 0, 0]) };
            if (cb && !cb.constant) L.b.color = cb;
            if (rb && !rb.constant) L.b.ring = rb;
            spec.layers.push({ name: e.name, shader: 'rect', x, y, w, h, uniforms: u });
            Object.assign(L, { x, y });
            common();
        } else if (e.kind === 'sprite') {
            const pad = e.attrs.pad != null ? Number(e.attrs.pad) : 4;
            const b = e.box;
            const x = Math.max(0, Math.floor(b.x - pad)), y = Math.max(0, Math.floor(b.y - pad));
            const w = Math.min(W, Math.ceil(b.x + b.w + pad)) - x, h = Math.min(bottom, Math.ceil(b.y + b.h + pad)) - y;
            if (!(w > 0 && h > 0)) fail(e, 'the sprite is empty');
            inPanel(e, { x, y, w, h }); safe(e, y);
            spec.layers.push({ name: e.name, shader: 'art', image: 'sprite.' + e.name + '.png', x, y, w, h, uniforms: {} });
            Object.assign(L, { x, y, el: e });
            common();
            if (!L.b.show) warnings.push(where(e) + ': a sprite without data-show is always shown (it could be art)');
        }
        logicLayers.push(L);
    });

    /* a gauge drawing the art is opaque over its field: a sprite under it is hidden there */
    spec.layers.forEach((s, i) => {
        if (s.shader !== 'art') return;
        spec.layers.slice(i + 1).filter((g) => g.shader === 'gauge' && g.art !== false).forEach((g) => {
            const r = gauges[g.name].rect;
            if (s.x < r[0] + r[2] && r[0] < s.x + s.w && s.y < r[1] + r[3] && r[1] < s.y + s.h)
                warnings.push(where(names[s.name]) + ': under gauge ' + g.name + '\'s field, which draws the art over it; put the sprite after the gauge');
        });
    });

    /* ------------------------------------------------------- logic.js */
    const extraFile = path.join(src, 'logic.extra.js');
    const extraSrc = fs.existsSync(extraFile) ? fs.readFileSync(extraFile, 'utf8') : null;
    spec.signals = Object.keys(comp.signals).filter((s) => s !== 'source');
    if (extraSrc) SIGNALS.forEach((s) => { if (new RegExp('\\b' + s + '\\b').test(extraSrc) && spec.signals.indexOf(s) < 0 && s !== 'source') spec.signals.push(s); });
    const logic = writeLogic(src, id, comp, logicLayers, params, colors, extraSrc);
    const logicFile = path.join(src, 'logic.js');
    fs.writeFileSync(logicFile, logic);

    /* --------------------------- texts: what each shows, on the bench drives */
    const shown = discover(logicFile, params, logicLayers);
    const texts = logicLayers.filter((l) => l.kind === 'text');
    const byFont = {};
    texts.forEach((l) => {
        const e = l.el, strs = Object.keys(shown[l.name] || {}).concat([l.nullText, e.placeholder]);
        l.strings = strs;
        const k = e.font.key;
        byFont[k] = byFont[k] || { font: M.fonts[k], chars: {}, layers: [] };
        byFont[k].layers.push(l);
        strs.join('').split('').concat((e.attrs.glyphs || '').split('')).forEach((c) => { byFont[k].chars[c] = true; });
    });
    /* each distinct font: its file, glyphs, cell and baseline */
    const fontNames = {};
    Object.keys(byFont).forEach((k) => {
        const F = byFont[k], f = F.font, first = F.layers[0].el;
        if (!f.loaded) fail(first, 'its font ' + f.weight + ' "' + f.family + '" did not load (an @font-face for it?)');
        const faces = M.faces.filter((x) => x.family.toLowerCase() === f.family.toLowerCase());
        if (!faces.length) fail(first, 'no @font-face for "' + f.family + '" (the atlas needs the font\'s file)');
        const wt = (x) => Number(String(x.weight).split(/\s+/)[0]) || 400;
        const face = faces.slice().sort((a, b) => Math.abs(wt(a) - f.weight) - Math.abs(wt(b) - f.weight))[0];
        if (!/^file:/.test(face.url)) fail(first, 'its font is not a local file: ' + face.url);
        const file = path.relative(src, url.fileURLToPath(face.url)).replace(/\\/g, '/');
        const chars = F.chars;
        chars[' '] = true; chars['-'] = true;
        if (Object.keys(chars).some((c) => /\d/.test(c))) '0123456789'.split('').forEach((c) => { chars[c] = true; });
        Object.keys(chars).forEach((c) => {
            if (f.adv[c] == null) {
                const l = F.layers.filter((x) => x.strings.join('').indexOf(c) >= 0)[0] || F.layers[0];
                fail(l.el, 'shows "' + c + '", which the build cannot measure (add it with data-glyphs)');
            }
        });
        const glyphs = Object.keys(chars).sort((a, b) => {
            const r = (c) => (/\d/.test(c) ? 0 : c === ' ' ? 1 : c === '-' ? 2 : 3);
            return r(a) - r(b) || (a < b ? -1 : a > b ? 1 : 0);
        }).join('');
        const adv = (c) => Math.round(f.adv[c]);
        const ink = glyphs.split('').filter((c) => c.trim()).map((c) => f.ink[c]);
        const asc = Math.max.apply(null, ink.map((i) => i[0]).concat([1])), desc = Math.max.apply(null, ink.map((i) => i[1]).concat([0]));
        const cw = Math.ceil(Math.max.apply(null, glyphs.split('').map((c) => Math.max(adv(c) + 1, (f.ink[c] ? f.ink[c][2] : 0) + 1, 2))));
        const ch = Math.ceil(asc + desc) + 4, bl = Math.ceil(asc) + 2;
        const dy = R2(bl - (f.base100 + (ch - 100) / 2));
        if (cw * glyphs.length > 2048) fail(first, 'its font\'s atlas would be ' + (cw * glyphs.length) + ' px wide (' + glyphs.length + ' glyphs of ' + cw + ' px; at most 2048): fewer characters or a smaller size');
        let name = 'f' + Math.round(f.size) + 'w' + f.weight;
        while (fontNames[name]) name += 'x';
        fontNames[name] = true;
        spec.fonts[name] = { file, weight: Number(f.weight), size: R2(f.size), cell: [cw, ch], dy, glyphs };
        if (f.tracking) spec.fonts[name].tracking = R2(f.tracking);
        if (f.proportional) spec.fonts[name].proportional = true;
        F.layers.forEach((l) => {
            const e = l.el;
            const width = (s) => s.split('').reduce((n, c) => n + adv(c), 0);
            const longest = Math.max.apply(null, l.strings.map((s) => s.length));
            if (longest > 16) fail(e, 'can show ' + longest + ' characters ("' + l.strings.filter((s) => s.length === longest)[0] + '"; at most 16)');
            const w = e.attrs.width ? Number(e.attrs.width) : Math.ceil(Math.max.apply(null, l.strings.map(width))) + 2;
            const x = Math.round(l.align === 'right' ? e.anchorX - w : l.align === 'center' ? e.anchorX - w / 2 : e.anchorX);
            const y = Math.round(e.baseline - bl);
            inPanel(e, { x, y, w, h: ch });
            safe(e, e.baseline - asc, 'its text');
            const s = spec.layers.filter((x) => x.name === l.name)[0];
            Object.assign(s, { font: name, x, y, w, cells: Math.max(1, Math.min(16, e.attrs.cells ? Number(e.attrs.cells) : longest)) });
            Object.assign(l, { x, y });
        });
    });
    /* the text layers' own x, y for data-dx / dy: rewrite the logic with them */
    fs.writeFileSync(logicFile, writeLogic(src, id, comp, logicLayers, params, colors, extraSrc));

    /* the limits, before Chrome renders anything more */
    const assets = 1 + Object.keys(spec.paths).filter((n) => !spec.paths[n].mirror && !spec.paths[n].copy).length + Object.keys(spec.fonts).length +
        spec.layers.filter((l) => l.shader === 'art').length;
    if (assets > core.LIMITS.assets) throw new DesignError(assets + ' textures (the art, ' + Object.keys(spec.paths).filter((n) => !spec.paths[n].mirror && !spec.paths[n].copy).length +
        ' fields, ' + Object.keys(spec.fonts).length + ' fonts (' + Object.keys(spec.fonts).join(', ') + '), ' + spec.layers.filter((l) => l.shader === 'art').length +
        ' sprites); at most ' + core.LIMITS.assets + ': reuse fields (data-reuse), share fonts (same family, weight, size and tracking) or drop a sprite');

    /* ------------------------------------------------- art and sprites */
    const banner = '<!-- generated by tools/design_build.js from design.html: edit the design, not this -->';
    const artHtml = withHead(SOURCE, hideCss(null) + '\n' + banner);
    fs.writeFileSync(path.join(src, 'art.html'), artHtml);
    spec.layers.filter((l) => l.shader === 'art').forEach((l) => {
        const page = path.join(src, '.sprite.' + l.name + '.html');
        fs.writeFileSync(page, withHead(SOURCE, hideCss(l.name)));
        let img;
        try { img = screenshot(page, bottom, tmp); } finally { fs.unlinkSync(page); }
        const out = Buffer.alloc(l.w * l.h * 4);
        for (let y = 0; y < l.h; y++) img.rgba.copy(out, y * l.w * 4, ((l.y + y) * W + l.x) * 4, ((l.y + y) * W + l.x + l.w) * 4);
        fs.writeFileSync(path.join(src, l.image), writePng(l.w, l.h, out));
    });

    fs.writeFileSync(path.join(src, 'theme.src.json'), JSON.stringify(spec, null, 1) + '\n');
    warnings.forEach((w) => console.warn('warning: ' + w));
    const counts = {};
    spec.layers.forEach((l) => { counts[l.shader] = (counts[l.shader] || 0) + 1; });
    console.log(id + ': design -> ' + (spec.layers.length + 1) + ' layers (' + Object.keys(counts).map((k) => counts[k] + ' ' + k).join(', ') + ' and the art), ' +
        assets + ' textures, fonts ' + Object.keys(spec.fonts).map((n) => n + ' (' + spec.fonts[n].glyphs.length + ' glyphs)').join(', ') + (map ? ', a map slot' : ''));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* leave it */ }
    return spec;
}

/* The logic: the runtime, the lets and each layer's bindings. */
function writeLogic(src, id, comp, layers, params, colors, extraSrc) {
    const rt = fs.readFileSync(path.join(__dirname, 'design_runtime.js'), 'utf8');
    const runtime = rt.slice(rt.indexOf('/* RUNTIME START */'), rt.indexOf('/* RUNTIME END */') + '/* RUNTIME END */'.length);
    const fn = (b) => b.source;
    const lines = [];
    lines.push('// SPDX-License-Identifier: GPL-3.0-or-later');
    lines.push('// Generated by tools/design_build.js from themes/' + path.basename(src) + '/design.html (and logic.extra.js):');
    lines.push('// edit those, not this. The bindings, compiled; see DESIGNS.md.');
    lines.push("'use strict';");
    lines.push(runtime);
    lines.push('const P = ' + JSON.stringify(params) + ';');
    lines.push('const C = ' + JSON.stringify(colors) + ';');
    lines.push('const LETS = [');
    comp.lets.forEach((l) => lines.push('    [' + JSON.stringify(l.name) + ', ' + JSON.stringify(l.id) + ', ' + l.source + '],'));
    lines.push('];');
    lines.push('const LAYERS = [');
    layers.forEach((l) => {
        const info = { name: l.name, kind: l.kind, x: l.x, y: l.y };
        if (l.rate) info.rate = l.rate;
        if (l.kind === 'gauge') Object.assign(info, { t0: l.t0, t1: l.t1, segs: l.segs, segEnd: l.segEnd });
        if (l.kind === 'text') info.nullText = l.nullText;
        const b = Object.keys(l.b).map((k) => '        ' + JSON.stringify(k) + ': [' + JSON.stringify(l.b[k].id) + ', ' + fn(l.b[k]) + '],');
        lines.push('    { info: ' + JSON.stringify(info) + ', b: {');
        b.forEach((x) => lines.push(x));
        lines.push('    } },');
    });
    lines.push('];');
    if (extraSrc) {
        lines.push('/* logic.extra.js */');
        lines.push('const EXTRA = (function () { const module = { exports: {} }; const exports = module.exports;');
        lines.push(extraSrc);
        lines.push('return module.exports; })();');
    } else lines.push('const EXTRA = null;');
    lines.push(UPDATE);
    return lines.join('\n') + '\n';
}

/* the generated logic's update (Node 8: no newer syntax) */
const UPDATE = `
const SAID = { 'band-color': 'color', 'needle-color': 'needle', 'glow-color': 'glow', 'red-color': 'red' };
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
function layer(l, S, Lv, st, ctx) {
    const i = l.info, b = l.b, o = {};
    let hide = false;
    const ev = (k) => DR.evaluate(st, b[k][0], b[k][1], S, Lv, ctx);
    Object.keys(b).forEach((k) => {
        const r = ev(k);
        const none = DR.isNull(r);
        if (k === 'show') { if (none || !r) hide = true; return; }
        if (k === 'dx' || k === 'dy') { if (none) hide = true; else o[k === 'dx' ? 'x' : 'y'] = (k === 'dx' ? i.x : i.y) + r; return; }
        if (i.kind === 'text' && k === 'text') { o.text = none ? i.nullText : String(r); return; }
        if (k === 'value' || k === 'lit') {
            if (none) { hide = true; return; }
            if (k === 'lit') o.lit = r;
            else o.value = i.t0 + clamp01(r) * (i.t1 - i.t0);
            return;
        }
        if (none) return;
        if (k === 'flash') o.flash = r === true ? 1 : r === false ? 0 : r;
        else if (k === 'from') { o.uniforms = o.uniforms || {}; o.uniforms.u_seg = [i.segs[0], i.segs[1], i.t0 + clamp01(r) * (i.t1 - i.t0), i.segEnd]; }
        else if (k.indexOf('u_') === 0) { o.uniforms = o.uniforms || {}; o.uniforms[k] = DR.col(r); }
        else o[SAID[k] || (k === 'ring' ? 'ring' : 'color')] = DR.col(r);
    });
    o.visible = !hide;
    return o;
}
module.exports = {
    update(sig, ctx) {
        const st = ctx.state.design || (ctx.state.design = { layers: {} });
        const S = DR.undef(sig || {});
        const Lv = {};
        LETS.forEach((l) => { Lv[l[0]] = DR.evaluate(st, l[1], l[2], S, Lv, ctx); });
        let out = {};
        LAYERS.forEach((l) => {
            const ls = st.layers[l.info.name] || (st.layers[l.info.name] = {});
            if (l.info.rate && ls.out && ctx.t >= ls.t && ctx.t - ls.t < 1 / l.info.rate - 1e-6) { out[l.info.name] = ls.out; return; }
            ls.t = ctx.t;
            ls.out = layer(l, S, Lv, st, ctx);
            out[l.info.name] = ls.out;
        });
        if (EXTRA && EXTRA.update) { const r = EXTRA.update(sig, ctx, out, { lets: Lv, P: P, C: C, DR: DR }); if (r) out = r; }
        return out;
    },
};
`;

/* Every string each text layer shows over the bench drives (both modes, two
 * laps) and with the car giving little or nothing. */
function discover(logicFile, params, layers) {
    delete require.cache[require.resolve(logicFile)];
    const logic = require(logicFile);
    const shown = {};
    const run = (sigOf, n, dt) => {
        const ctx = { params, fonts: {}, core, state: {}, t: 0, dt };
        for (let i = 0; i < n; i++) {
            ctx.t = i * dt;
            const said = logic.update(sigOf(ctx.t, i), ctx) || {};
            layers.filter((l) => l.kind === 'text').forEach((l) => {
                if (said[l.name] && said[l.name].text != null) (shown[l.name] = shown[l.name] || {})[String(said[l.name].text)] = true;
            });
        }
    };
    ['sport', 'comfort'].forEach((mode) => run((t) => Object.assign({ source: 'demo' }, sim.at(t, mode)), Math.ceil(sim.length(mode) * 2 / 0.04), 0.04));
    run((t, i) => ({ source: 'car', kmh: 50 + i, clock: '12:00' }), 20, 0.04);
    run(() => ({ source: 'car' }), 5, 0.04);
    return shown;
}

if (require.main === module) {
    const dirs = process.argv.slice(2).filter((a, i, all) => a[0] !== '-' && all[i - 1] !== '--chrome');
    if (!dirs.length) { console.error('usage: node tools/design_build.js themes/<id> [--chrome PATH] [--no-build] [--keep]'); process.exit(2); }
    try {
        dirs.forEach((d) => {
            designBuild(d);
            if (process.argv.indexOf('--no-build') < 0) require('./theme_build.js').build(path.resolve(d));
        });
    } catch (e) {
        console.error(e instanceof DesignError ? 'design: ' + e.message : (e.stack || e.message));
        process.exit(1);
    }
}

module.exports = { designBuild, identifiers, preprocess };
