#!/usr/bin/env python3
"""Genera el ícono del DexPort Agent (adaptive-ready PNG, 432x432 + 192)."""
from PIL import Image, ImageDraw, ImageFont
import os

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, "res", "mipmap-xxxhdpi")
os.makedirs(OUT, exist_ok=True)

S = 432
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# fondo: cuadrado redondeado azul-degradado (estilo DexPort)
r = 96
top = (13, 42, 64)      # #0d2a40
bot = (5, 14, 26)       # #050e1a
grad = Image.new("RGBA", (S, S), (0, 0, 0, 0))
gd = ImageDraw.Draw(grad)
for y in range(S):
    t = y / S
    c = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)) + (255,)
    gd.line([(0, y), (S, y)], fill=c)
mask = Image.new("L", (S, S), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=255)
img.paste(grad, (0, 0), mask)

# borde sutil cian
d.rounded_rectangle([1, 1, S - 2, S - 2], radius=r, outline=(56, 189, 248, 90), width=3)

# "D" grande con tipografía
font = None
for path in (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
):
    if os.path.exists(path):
        font = ImageFont.truetype(path, 260)
        break
if font is None:
    font = ImageFont.load_default()

text = "D"
bbox = d.textbbox((0, 0), text, font=font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
x = (S - tw) / 2 - bbox[0]
y = (S - th) / 2 - bbox[1] - 12
# sombra suave
d.text((x + 4, y + 8), text, font=font, fill=(0, 0, 0, 120))
d.text((x, y), text, font=font, fill=(125, 211, 252, 255))

# punto-cursor tipo terminal (guiño a "agent")
d.ellipse([S - 108, S - 116, S - 76, S - 84], fill=(61, 220, 132, 255))

img.save(os.path.join(OUT, "ic_launcher.png"))
img.resize((192, 192), Image.LANCZOS).save(os.path.join(BASE, "res", "drawable", "ic_notification.png"))
print("ícono OK →", OUT)
