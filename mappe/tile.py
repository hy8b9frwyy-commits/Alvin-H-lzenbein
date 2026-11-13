#!/usr/bin/env python3
"""Cut a tall full-page screenshot into columns and lay them side by side, for reviewing a layout at a glance.
Usage: python3 mappe/tile.py shot.png out.png [column_height] [max_columns] [start_column]"""
import sys
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
col_h = int(sys.argv[3]) if len(sys.argv) > 3 else 2200
max_cols = int(sys.argv[4]) if len(sys.argv) > 4 else 5
start = int(sys.argv[5]) if len(sys.argv) > 5 else 0
im = Image.open(src).convert("RGB")
w, h = im.size
cols = [im.crop((0, y, w, min(y + col_h, h))) for y in range(0, h, col_h)][start:start + max_cols]
sheet = Image.new("RGB", (len(cols) * (w + 16) - 16, col_h), (128, 128, 128))
for i, c in enumerate(cols):
    sheet.paste(c, (i * (w + 16), 0))
sheet.save(dst)
print(dst, sheet.size, "page height", h)
