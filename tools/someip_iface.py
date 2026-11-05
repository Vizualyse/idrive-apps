# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
"""Turns the head unit's SOME/IP catalog (/etc/oap/someip/someip-interfaces.json)
into the interface JSON /usr/lib/someip.node takes (the oap-mainapp src-gen
format), for root tools that call head-unit services through someip.node
(knowledge/sound.md). Matches the main app's own generated files on 125 of
their 131 methods (the rest: navigation types with struct inheritance).

    python tools/someip_iface.py <catalog> check <src-gen dir>        compare with every file there
    python tools/someip_iface.py <catalog> gen <interface> [methods,...] [out.json]
"""
import json
import os
import sys

PRIM = {'UInt8', 'UInt16', 'UInt32', 'UInt64', 'Int8', 'Int16', 'Int32', 'Int64', 'Boolean', 'Float', 'Double',
        'Utf8D', 'Utf16D', 'Utf8', 'Utf16', 'ByteBuffer'}


class Gen:
    def __init__(self, cat):
        self.cat = cat
        self.types = cat['datatypes']

    def typ(self, ref, member=None):
        """the schema for a dataRef, with the member's own attributes"""
        if ref in PRIM or ref not in self.types:
            o = {'t': ref}
            self.attrs(o, member)
            return o
        d = self.types[ref]
        k = d['type']
        if k == 'typedef':
            return self.typ(d['dataRef'], member)
        if k == 'enum':
            o = {'t': 'Enum'}
            if 'enumWidth' in d:
                o['w'] = d['enumWidth']
            o['e'] = self.items(d)
            return o
        if k == 'struct':
            return {'t': 'Struct', 'e': [self.named(m) for m in d['members']]}
        if k == 'array':
            o = {'t': 'ArrayD'}
            if 'arrayMinLength' in d:
                o['nl'] = d['arrayMinLength']
            if 'arrayMaxLength' in d:
                o['xl'] = d['arrayMaxLength']
            o['e'] = self.typ(d['dataRef'], d)
            return o
        if k == 'map':
            return {'t': 'Map', 'k': self.mapped(d['keyDataRef']), 'v': self.mapped(d['valueDataRef'])}
        if k == 'union':
            return {'t': 'Union', 'e': [self.named(m) for m in d['members']]}
        raise ValueError('type ' + k)

    def items(self, d):
        # an enum that extends another: the base's items first
        base = self.items(self.types[d['extends']]) if d.get('extends') in self.types else {}
        out = dict(base)
        out.update(d['items'])
        return out

    def mapped(self, ref):
        # a named array as a map's key or value keeps its name
        o = self.typ(ref)
        if ref in self.types and self.types[ref]['type'] in ('array', 'typedef'):
            o = dict([('n', self.types[ref]['name'])] + list(o.items()))
        return o

    def attrs(self, o, m):
        if o['t'] in ('Utf16D', 'Utf16'):
            o['bo'] = True

    def named(self, m):
        o = {'n': m['name']}
        if 'defaultValue' in m:
            o['d'] = m['defaultValue']
        t = self.typ(m['dataRef'], m)
        if m.get('dimension'):
            a = {'t': 'ArrayD'}
            if 'arrayMinLength' in m:
                a['nl'] = m['arrayMinLength']
            if 'arrayMaxLength' in m:
                a['xl'] = m['arrayMaxLength']
            a['e'] = t
            t = a
        o.update(t)
        if 'bitWidth' in m:
            o['bw'] = m['bitWidth']
        return o

    def struct(self, args):
        return {'t': 'Struct', 'e': [self.named(a) for a in args]} if args else {}

    def iface(self, name, only=None):
        i = self.cat['interfaces'][name]
        out = {'name': i['name'], 'serviceId': i['serviceId'], 'version': i['version'],
               'instances': self.cat['instanceIDs'].get(name, {})}
        ms = {}
        for mn, m in i.get('methods', {}).items():
            if only and mn not in only:
                continue
            o = {'id': m['methodId'], 'schema': self.struct(m.get('inputs', []))}
            if 'outputs' in m:
                o['retSchema'] = self.struct(m['outputs'])
            if m.get('reliable'):
                o['reliable'] = True
            ms[mn] = o
        out['methods'] = ms
        fs = {}
        for fn, f in (i.get('fields') or {}).items():
            if only and fn not in only:
                continue
            o = {'schema': self.mapped(f['dataRef'])}
            for k in ('getter', 'setter'):
                if k in f:
                    o[k] = {'id': f[k]['id']}
            if 'notifier' in f:
                e = {'id': f['notifier']['id'], 'groups': f['notifier'].get('eventgroups', [])}
                if f['notifier'].get('reliable'):
                    e['reliable'] = True
                o['event'] = e
            fs[fn] = o
        if fs:
            out['fields'] = fs
        es = {}
        for en, e in (i.get('events') or i.get('broadcasts') or {}).items():
            if only and en not in only:
                continue
            o = {'id': e['eventId'], 'groups': e.get('eventgroups', []), 'schema': self.struct(e.get('outputs', []))}
            if e.get('selective'):
                o['selective'] = True
            if e.get('reliable'):
                o['reliable'] = True
            es[en] = o
        if es:
            out['events'] = es
        return out


def main():
    cat = json.load(open(sys.argv[1], encoding='utf-8'))
    g = Gen(cat)
    if sys.argv[2] == 'check':
        d = sys.argv[3]
        same = diff = 0
        for f in sorted(os.listdir(d)):
            ref = json.load(open(os.path.join(d, f), encoding='utf-8'))
            name = [k for k in cat['interfaces'] if k.replace('.', '_') + '.json' == f]
            if not name:
                continue
            want = set(ref.get('methods', {})) | set(ref.get('fields') or {}) | set(ref.get('events') or {})
            mine = g.iface(name[0], want)
            for kind in ('methods', 'fields', 'events'):
              for mn, m in (ref.get(kind) or {}).items():
                got = dict((mine.get(kind) or {}).get(mn) or {})
                for acc in ('getter', 'setter'):
                    if kind == 'fields' and acc not in m:
                        got.pop(acc, None)   # the app's manifest ("r", "w") decides whether it is generated
                if got == m:
                    same += 1
                else:
                    diff += 1
                    if diff <= 4:
                        print('DIFF', f, kind, mn)
                        print('  ref ', json.dumps(m)[:600])
                        print('  mine', json.dumps((mine.get(kind) or {}).get(mn))[:600])
        print('methods, fields and events equal: %d, different: %d' % (same, diff))
    else:
        only = set(sys.argv[4].split(',')) if len(sys.argv) > 4 and sys.argv[4] else None
        o = g.iface(sys.argv[3], only)
        s = json.dumps(o, indent=1)
        if len(sys.argv) > 5:
            open(sys.argv[5], 'w').write(s)
        else:
            print(s)


main()
