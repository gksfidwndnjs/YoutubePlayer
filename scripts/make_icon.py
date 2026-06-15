#!/usr/bin/env python3
"""Generate the app icon: a brushed-metal bezel framing a recessed CRT screen
with a glowing green play button — mirroring the real app.

Three elements (as requested):
  1. metal border  -> the actual assets/metal.png brushed steel (used on #player-bar)
  2. CRT container -> the dark-green recessed screen (#queue-list: #0c120e/#0f1a10,
                      scanlines, inner shadow, green glow)
  3. play icon     -> glowing CRT-green (#00e857) play triangle

Writes assets/icon.png (1024) and a multi-size assets/icon.ico.
"""
import os
from PIL import Image, ImageDraw, ImageFilter

R = 2048                       # supersampled render size
MASTER = 1024                  # final master size
HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, "..", "assets")
METAL = os.path.join(OUT, "metal.png")

GREEN = (0, 232, 87)


def rounded_mask(w, h, radius):
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=255)
    return m


def crt_screen(w, h, radius):
    """The recessed CRT container: vertical dark-green gradient + scanlines +
    edge vignette, matching #queue-list."""
    top, bot = (12, 18, 14), (15, 26, 16)          # #0c120e -> #0f1a10
    scr = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(scr)
    for y in range(h):
        t = y / (h - 1)
        c = tuple(round(top[i] + (bot[i] - top[i]) * t) for i in range(3))
        d.line([(0, y), (w, y)], fill=c)

    # scanlines (subtle dark rows, like the queue-list repeating gradient)
    period = max(3, round(h / 90))
    sl = Image.new("L", (w, h), 0)
    sld = ImageDraw.Draw(sl)
    for y in range(0, h, period):
        sld.line([(0, y), (w, y)], fill=70, width=max(1, period // 3))
    scr = Image.composite(Image.new("RGB", (w, h), (0, 0, 0)), scr, sl)

    # faint green phosphor tint
    scr = Image.blend(scr, Image.new("RGB", (w, h), (4, 30, 10)), 0.10)

    # top/bottom black vignette (queue-list's to-top / to-bottom 16% fades)
    vig = Image.new("L", (w, h), 0)
    vd = ImageDraw.Draw(vig)
    band = int(h * 0.18)
    for y in range(band):
        a = int(110 * (1 - y / band))
        vd.line([(0, y), (w, y)], fill=a)
        vd.line([(0, h - 1 - y), (w, h - 1 - y)], fill=a)
    scr = Image.composite(Image.new("RGB", (w, h), (0, 0, 0)), scr, vig)

    out = scr.convert("RGBA")
    out.putalpha(rounded_mask(w, h, radius))
    return out


def build():
    # ── 1) metal bezel from the real texture ────────────────────────────────
    metal = Image.open(METAL).convert("RGB").resize((R, R), Image.LANCZOS)
    img = metal.convert("RGBA")
    radius = int(R * 0.205)
    img.putalpha(rounded_mask(R, R, radius))

    # outer border + top rim highlight (raised metal edge catching light)
    rim = Image.new("RGBA", (R, R), (0, 0, 0, 0))
    bw = max(2, int(R * 0.012))
    ImageDraw.Draw(rim).rounded_rectangle(
        [bw, bw, R - 1 - bw, R - 1 - bw], radius=radius - bw,
        outline=(255, 255, 255, 90), width=bw)
    half = Image.new("L", (R, R), 0)
    ImageDraw.Draw(half).rectangle([0, 0, R, int(R * 0.5)], fill=255)
    rim = rim.filter(ImageFilter.GaussianBlur(R * 0.004))
    rim.putalpha(Image.composite(rim.split()[3], Image.new("L", (R, R), 0), half))
    img.alpha_composite(rim)
    border = Image.new("RGBA", (R, R), (0, 0, 0, 0))
    ImageDraw.Draw(border).rounded_rectangle(
        [1, 1, R - 2, R - 2], radius=radius,
        outline=(104, 104, 120, 235), width=max(2, int(R * 0.007)))
    img.alpha_composite(border)

    # ── 2) recessed CRT screen ──────────────────────────────────────────────
    frame = int(R * 0.150)                     # bezel thickness
    sx0, sy0, sx1, sy1 = frame, frame, R - frame, R - frame
    sw, sh = sx1 - sx0, sy1 - sy0
    s_rad = int(R * 0.075)

    # dark groove so the screen looks seated into the metal
    groove = Image.new("RGBA", (R, R), (0, 0, 0, 0))
    g = int(R * 0.016)
    ImageDraw.Draw(groove).rounded_rectangle(
        [sx0 - g, sy0 - g, sx1 + g, sy1 + g], radius=s_rad + g, fill=(0, 0, 0, 200))
    img.alpha_composite(groove.filter(ImageFilter.GaussianBlur(R * 0.012)))

    screen = crt_screen(sw, sh, s_rad)
    s_mask = rounded_mask(sw, sh, s_rad)

    # inner shadow (top-left heavier) + green rim glow, clipped to the screen
    inner = Image.new("RGBA", (sw, sh), (0, 0, 0, 0))
    iw = int(R * 0.030)
    ImageDraw.Draw(inner).rounded_rectangle(
        [0, 0, sw - 1, sh - 1], radius=s_rad, outline=(0, 0, 0, 220), width=iw)
    inner = inner.filter(ImageFilter.GaussianBlur(R * 0.012))
    inner.putalpha(Image.composite(inner.split()[3], Image.new("L", (sw, sh), 0), s_mask))
    screen.alpha_composite(inner)

    glow_rim = Image.new("RGBA", (sw, sh), (0, 0, 0, 0))
    ImageDraw.Draw(glow_rim).rounded_rectangle(
        [2, 2, sw - 3, sh - 3], radius=s_rad, outline=GREEN + (90,), width=max(2, int(R * 0.004)))
    glow_rim = glow_rim.filter(ImageFilter.GaussianBlur(R * 0.006))
    glow_rim.putalpha(Image.composite(glow_rim.split()[3], Image.new("L", (sw, sh), 0), s_mask))
    screen.alpha_composite(glow_rim)

    img.alpha_composite(screen, (sx0, sy0))

    # ── 3) glowing play triangle on the screen ──────────────────────────────
    cx, cy = R // 2, R // 2
    r = sh * 0.30
    ox = -sw * 0.015
    tri = [
        (cx - r * 0.46 + ox, cy - r * 0.62),
        (cx - r * 0.46 + ox, cy + r * 0.62),
        (cx + r * 0.74 + ox, cy),
    ]
    glow = Image.new("RGBA", (R, R), (0, 0, 0, 0))
    ImageDraw.Draw(glow).polygon(tri, fill=GREEN + (255,))
    glow_clip = rounded_mask(sw, sh, s_rad)
    full_clip = Image.new("L", (R, R), 0)
    full_clip.paste(glow_clip, (sx0, sy0))
    for rad, op in ((R * 0.05, 160), (R * 0.02, 230)):
        gg = glow.filter(ImageFilter.GaussianBlur(rad))
        a = gg.split()[3].point(lambda v, o=op: min(v, o))
        gg.putalpha(Image.composite(a, Image.new("L", (R, R), 0), full_clip))
        img.alpha_composite(gg)

    face = Image.new("RGBA", (R, R), (0, 0, 0, 0))
    ImageDraw.Draw(face).polygon(tri, fill=GREEN + (255,))
    hi = Image.new("RGBA", (R, R), (0, 0, 0, 0))
    ImageDraw.Draw(hi).polygon(
        [tri[0], tri[2], (tri[0][0], tri[0][1] + (tri[1][1] - tri[0][1]) * 0.5)],
        fill=(180, 255, 205, 140))
    face.alpha_composite(hi.filter(ImageFilter.GaussianBlur(R * 0.01)))
    img.alpha_composite(face)

    # final round clip
    img.putalpha(Image.composite(img.split()[3], Image.new("L", (R, R), 0),
                                 rounded_mask(R, R, radius)))
    return img.resize((MASTER, MASTER), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    master = build()
    png_path = os.path.join(OUT, "icon.png")
    ico_path = os.path.join(OUT, "icon.ico")
    master.save(png_path)
    sizes = [16, 24, 32, 48, 64, 128, 256]
    master.save(ico_path, format="ICO", sizes=[(s, s) for s in sizes])
    print("wrote:", png_path, ico_path, "sizes:", sizes)


if __name__ == "__main__":
    main()
