#!/usr/bin/env python3
"""
Rewrites APK zip entries so every name uses forward slashes.
aapt2 on Windows writes backslash entry names, which Android's asset
manager cannot read. Python's zipfile always writes forward slashes.

Usage: python fixzip.py <in.apk> <out.apk>
"""
import sys
import zipfile

src, dst = sys.argv[1], sys.argv[2]

with zipfile.ZipFile(src) as zin:
    infos = zin.infolist()
    with zipfile.ZipFile(dst, "w") as zout:
        fixed = 0
        for info in infos:
            data = zin.read(info.filename)
            name = info.filename.replace("\\", "/")
            if name != info.filename:
                fixed += 1
            # resources.arsc must stay uncompressed; everything else deflates.
            compress = zipfile.ZIP_STORED if name == "resources.arsc" else zipfile.ZIP_DEFLATED
            zout.writestr(name, data, compress_type=compress)
        print(f"rewrote {len(infos)} entries ({fixed} names fixed)")

print(f"wrote {dst}")
