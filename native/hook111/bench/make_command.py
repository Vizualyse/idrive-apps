#!/usr/bin/env python3
"""Make a send.plist for hook111's bench channel: a binary plist {type, params}.

    python3 make_command.py '{"type": "requestUI", "params": {"url": "maps:/car/instrumentcluster"}}' send.plist

Copy it to the unit's /run/hook111/log/send.plist (as root); the hook sends it
on the phone's next command and renames it send.<n>.done. Numbers stay
integers, true/false booleans; {"$data": "<hex>"} gives bytes.
Not shipped to the unit (component.json lists what is).
"""
import json
import plistlib
import sys


def conv(o):
    if isinstance(o, dict):
        if set(o) == {"$data"}:
            return bytes.fromhex(o["$data"])
        return {k: conv(v) for k, v in o.items()}
    if isinstance(o, list):
        return [conv(v) for v in o]
    return o


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    cmd = conv(json.loads(sys.argv[1]))
    if not isinstance(cmd, dict) or not isinstance(cmd.get("type"), str):
        sys.exit("needs a JSON object with a string \"type\"")
    with open(sys.argv[2], "wb") as f:
        plistlib.dump(cmd, f, fmt=plistlib.FMT_BINARY)


if __name__ == "__main__":
    main()
