"""Rasterize the authored geometric icon without third-party dependencies."""
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / 'public'

def rounded_rect(x, y, left, top, width, height, radius):
    if not (left <= x < left + width and top <= y < top + height):
        return False
    cx = min(max(x, left + radius), left + width - radius)
    cy = min(max(y, top + radius), top + height - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2

def color(x, y):
    ink = (37, 40, 32)
    paper = (246, 245, 240)
    accent = (148, 173, 67)
    if rounded_rect(x, y, 50, 84, 25, 24, 5):
        return accent
    for box in [(91,46,51,24,5), (50,84,92,24,5), (50,122,92,24,5)]:
        if rounded_rect(x,y,*box):
            return ink
    return paper

def chunk(kind, data):
    return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data) & 0xffffffff)

for size in (192, 512):
    scanlines = bytearray()
    for y in range(size):
        scanlines.append(0)
        for x in range(size):
            samples = [color((x+dx)*192/size, (y+dy)*192/size) for dx in (.25,.75) for dy in (.25,.75)]
            scanlines.extend(round(sum(c[i] for c in samples)/4) for i in range(3))
    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B',size,size,8,2,0,0,0))
    data += chunk(b'IDAT',zlib.compress(bytes(scanlines))) + chunk(b'IEND',b'')
    (ROOT / f'icon-{size}.png').write_bytes(data)

# Android tints the alpha mask of the small notification badge. A full app
# icon with an opaque background becomes a solid square instead of our mark.
size = 96
scanlines = bytearray()
for y in range(size):
    scanlines.append(0)
    for x in range(size):
        coverage = sum(
            any(rounded_rect(x + dx, y + dy, *box) for box in
                [(44, 8, 40, 18, 3), (12, 38, 72, 18, 3), (12, 68, 72, 18, 3)])
            for dx in (.25, .75) for dy in (.25, .75)
        )
        scanlines.extend((255, 255, 255, round(255 * coverage / 4)))
data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', size, size, 8, 6, 0, 0, 0))
data += chunk(b'IDAT', zlib.compress(bytes(scanlines))) + chunk(b'IEND', b'')
(ROOT / 'notification-badge-96.png').write_bytes(data)
