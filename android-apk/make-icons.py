#!/usr/bin/env python3
"""Generate Quanta launcher icons from leeticon.png (the provided app icon).

Creates properly sized, density-correct PNGs:
  mipmap-mdpi    48x48   ic_launcher.png + ic_launcher_round.png
  mipmap-hdpi    72x72
  mipmap-xhdpi   96x96
  mipmap-xxhdpi  144x144
  mipmap-xxxhdpi 192x192
  mipmap-xxxhdpi 432x432 adaptive foreground (icon art in the safe zone)

Round icons get the image cover-cropped to a circle on a transparent
background; the adaptive foreground keeps the full art inside Android's
66/108 safe zone over a transparent layer (background color comes from
colors.xml). Idempotent and re-runnable.
"""
from PIL import Image, ImageDraw, ImageOps
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "leeticon.png")
RES = os.path.join(HERE, "app", "src", "main", "res")

DENSITIES = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}

src = Image.open(SRC).convert("RGBA")


def cover(img, size):
    """Scale + center-crop to exactly size x size."""
    return ImageOps.fit(img, (size, size), Image.LANCZOS)


def circle_mask(size):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.ellipse((0, 0, size - 1, size - 1), fill=255)
    return mask


for folder, size in DENSITIES.items():
    out_dir = os.path.join(RES, folder)
    os.makedirs(out_dir, exist_ok=True)

    # Square launcher icon with a tiny corner radius feel (raw square PNG is fine;
    # launchers mask it themselves on modern Android).
    cover(src, size).save(os.path.join(out_dir, "ic_launcher.png"), optimize=True)

    # Round variant for round-icon launchers.
    rounded = cover(src, size)
    mask = circle_mask(size)
    transparent = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    transparent.paste(rounded, (0, 0), mask)
    transparent.save(os.path.join(out_dir, "ic_launcher_round.png"), optimize=True)

# Adaptive icon foreground: 432x432 with the art inside the center ~66% safe zone
fg_size = 432
safe = int(fg_size * 0.62)  # art diameter inside the 108dp canvas
canvas = Image.new("RGBA", (fg_size, fg_size), (0, 0, 0, 0))
art = cover(src, safe)
offset = (fg_size - safe) // 2
canvas.paste(art, (offset, offset), art)
out_dir = os.path.join(RES, "mipmap-xxxhdpi")
canvas.save(os.path.join(out_dir, "ic_launcher_foreground.png"), optimize=True)

# Legacy round-xxxhdpi folder (same 192px round art as xxxhdpi).
round_dir = os.path.join(RES, "mipmap-round-xxxhdpi")
os.makedirs(round_dir, exist_ok=True)
round_src = Image.open(os.path.join(RES, "mipmap-xxxhdpi", "ic_launcher_round.png"))
round_src.save(os.path.join(round_dir, "ic_launcher_round.png"), optimize=True)

print("icons written:")
for folder, size in sorted(DENSITIES.items()):
    for name in ("ic_launcher.png", "ic_launcher_round.png"):
        p = os.path.join(RES, folder, name)
        print(f"  {folder}/{name} ({os.path.getsize(p)} bytes)")
p = os.path.join(RES, "mipmap-xxxhdpi", "ic_launcher_foreground.png")
print(f"  mipmap-xxxhdpi/ic_launcher_foreground.png ({os.path.getsize(p)} bytes)")
p = os.path.join(RES, "mipmap-round-xxxhdpi", "ic_launcher_round.png")
print(f"  mipmap-round-xxxhdpi/ic_launcher_round.png ({os.path.getsize(p)} bytes)")
