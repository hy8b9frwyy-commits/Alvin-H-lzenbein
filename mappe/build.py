#!/usr/bin/env python3
"""Build the model portfolio: web page fragment, print HTML (A4 book + comp card) and all image derivatives.

Usage:
    python3 mappe/build.py --profile private/profile.json --layout private/layout.json --photos photos --out dist

Photos and the private profile never enter the repository (see .gitignore). Missing photos are replaced
by drawn placeholders, so the layout can be developed without any real pictures.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import shutil
from pathlib import Path

import numpy as np
from jinja2 import Environment, FileSystemLoader, select_autoescape
from PIL import Image, ImageCms, ImageDraw, ImageFilter, ImageFont, ImageOps

HERE = Path(__file__).resolve().parent
CUTOUT_MODEL = "birefnet-general-lite"
SIZES = {"web": (1700, 82), "thumb": (840, 78), "print": (2500, 86), "mail": (1300, 70)}

try:  # iPhone originals may arrive as HEIC
    import pillow_heif  # type: ignore

    pillow_heif.register_heif_opener()
except Exception:  # pragma: no cover - optional dependency
    pass


# ---------------------------------------------------------------- imaging

def load_rgb(path: Path) -> Image.Image:
    """Open, apply EXIF orientation, convert any embedded colour profile (e.g. Display P3) to sRGB."""
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    icc = img.info.get("icc_profile")
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGB")
    if icc:
        try:
            src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
            dst = ImageCms.createProfile("sRGB")
            img = ImageCms.profileToProfile(img, src, dst, outputMode="RGB")
        except Exception:
            img = img.convert("RGB")
    return img.convert("RGB")


def _to_lin(a):
    return np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)


def _to_srgb(a):
    a = np.clip(a, 0, 1)
    return np.where(a <= 0.0031308, a * 12.92, 1.055 * a ** (1 / 2.4) - 0.055)


def grade(img: Image.Image, spec: dict) -> Image.Image:
    """Apply the look for one photo. look: natural | color | bw. Optional ev, contrast, sat, temp, tint, grain."""
    look = spec.get("look", "color")
    a = np.asarray(img, dtype=np.float32) / 255.0
    ev = float(spec.get("ev", 0))
    temp = float(spec.get("temp", 0))  # + warmer, - cooler
    tint = float(spec.get("tint", 0))  # + magenta, - green
    if ev or temp or tint:
        lin = _to_lin(a) * (2.0 ** ev)
        lin[..., 0] *= 1 + 0.10 * temp + 0.04 * tint
        lin[..., 1] *= 1 - 0.06 * tint
        lin[..., 2] *= 1 - 0.10 * temp + 0.04 * tint
        a = _to_srgb(lin)
    if spec.get("auto"):
        lum = a @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
        lo, hi = np.percentile(lum, [0.4, 99.6])
        k = float(spec["auto"]) if spec["auto"] is not True else 0.6
        lo, hi = lo * k, 1 - (1 - hi) * k
        a = np.clip((a - lo) / max(hi - lo, 1e-3), 0, 1)
    defaults = {"natural": (0.0, 1.0), "color": (0.10, 0.94), "bw": (0.16, 0.0)}[look]
    contrast = float(spec.get("contrast", defaults[0]))
    sat = float(spec.get("sat", defaults[1]))
    if look == "bw":
        g = a @ np.array([0.42, 0.46, 0.12], dtype=np.float32)
        a = np.repeat(g[..., None], 3, axis=2)
    elif sat != 1.0:
        g = (a @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32))[..., None]
        a = g + (a - g) * sat
    if contrast:
        a = a - contrast * np.sin(2 * np.pi * np.clip(a, 0, 1)) / (2 * np.pi)
    lift = float(spec.get("lift", 0.012 if look != "natural" else 0))
    if lift:
        a = lift + a * (1 - lift)
    grain = float(spec.get("grain", 0.014 if look == "bw" else 0))
    if grain:
        rng = np.random.default_rng(int(hashlib.md5(str(spec.get("src", "")).encode()).hexdigest()[:8], 16))
        n = rng.normal(0, grain, a.shape[:2]).astype(np.float32)
        a = a + n[..., None]
    return Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8), "RGB")


def placeholder(pid: str, wide: bool = False) -> Image.Image:
    """A drawn stand-in: soft backdrop, a neutral figure and the photo id."""
    w, h = (2400, 1600) if wide else (1800, 2400)
    seed = int(hashlib.md5(pid.encode()).hexdigest()[:6], 16)
    base = 150 + seed % 60
    grad = np.linspace(base + 30, base - 50, h, dtype=np.float32)[:, None].repeat(w, 1)
    img = Image.fromarray(np.stack([grad, grad * 0.99, grad * 0.97], 2).clip(0, 255).astype(np.uint8), "RGB")
    d = ImageDraw.Draw(img)
    cx, top = w * (0.42 + (seed % 17) / 100), h * 0.2
    r = min(w, h) * 0.13
    tone = (base - 78, base - 80, base - 84)
    d.ellipse([cx - r, top, cx + r, top + 2.5 * r], fill=tone)
    d.rounded_rectangle([cx - 2.6 * r, top + 2.8 * r, cx + 2.6 * r, h + 200], radius=int(r * 1.5), fill=tone)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 64)
    except Exception:
        font = ImageFont.load_default()
    d.text((60, h - 130), pid.upper(), fill=(245, 245, 240), font=font)
    return img.filter(ImageFilter.GaussianBlur(1.2))


def export(img: Image.Image, path: Path, long_edge: int, quality: int) -> None:
    w, h = img.size
    s = long_edge / max(w, h)
    if s < 1:
        img = img.resize((round(w * s), round(h * s)), Image.LANCZOS)
        img = img.filter(ImageFilter.UnsharpMask(radius=1.1, percent=55, threshold=2))
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "JPEG", quality=quality, optimize=True, progressive=True, subsampling=0 if quality >= 84 else 2)


def make_cutout(img: Image.Image, paths: list) -> None:
    """Separate the figure from its background (rembg) and save it with transparency, same frame as the photo."""
    from rembg import new_session, remove

    w, h = img.size
    s = 1700 / max(w, h)
    base = img.resize((round(w * s), round(h * s)), Image.LANCZOS) if s < 1 else img
    cut = remove(base, session=new_session(CUTOUT_MODEL), post_process_mask=True)
    a = np.asarray(cut.split()[-1], dtype=np.float32) / 255.0
    a = np.clip((a - 0.08) / 0.84, 0, 1)  # drop faint halo, keep soft hair edges
    cut.putalpha(Image.fromarray((a * 255).astype(np.uint8)))
    for path in paths:
        path.parent.mkdir(parents=True, exist_ok=True)
        cut.save(path, "WEBP", quality=88, method=5)


def process_photos(layout: dict, photos_dir: Path, out: Path, mail: bool) -> dict:
    """Create every derivative; return id -> metadata used by the templates."""
    meta = {}
    for pid, spec in layout["photos"].items():
        spec = dict(spec, src=spec.get("src", pid))
        src = photos_dir / spec["src"]
        if src.is_file():
            img = load_rgb(src)
            if spec.get("rotate"):
                img = img.rotate(-float(spec["rotate"]), expand=True, resample=Image.BICUBIC)
            if spec.get("crop"):  # relative box: left, top, right, bottom
                l, t, r, b = spec["crop"]
                w, h = img.size
                img = img.crop((round(l * w), round(t * h), round(r * w), round(b * h)))
            img = grade(img, spec)
            real = True
        else:
            img = placeholder(pid, wide=spec.get("ph") == "wide")
            if spec.get("look") == "bw":
                img = ImageOps.grayscale(img).convert("RGB")
            real = False
        export(img, out / "web" / "img" / f"{pid}.jpg", *SIZES["web"])
        export(img, out / "web" / "img" / f"{pid}-s.jpg", *SIZES["thumb"])
        export(img, out / "print" / "img" / f"{pid}.jpg", *SIZES["print"])
        if mail:
            export(img, out / "print" / "img-mail" / f"{pid}.jpg", *SIZES["mail"])
        if real and layout["cover"].get("cutout") and pid == layout["cover"]["photo"]:
            make_cutout(img, [out / "web" / "img" / f"{pid}-cut.webp", out / "print" / "img" / f"{pid}-cut.webp"]
                        + ([out / "print" / "img-mail" / f"{pid}-cut.webp"] if mail else []))
        w, h = img.size
        meta[pid] = {
            "id": pid, "w": w, "h": h, "ratio": round(w / h, 4), "real": real,
            "pos": spec.get("pos", "50% 35%"), "alt": spec.get("alt", ""), "caption": spec.get("caption", ""),
        }
    return meta


# ---------------------------------------------------------------- profile helpers

SHOE_US = {38: 6, 39: 6.5, 40: 7, 41: 8, 42: 8.5, 43: 9.5, 44: 10, 45: 11, 46: 12, 47: 12.5, 48: 13.5}


def feet_inches(cm: float) -> str:
    total = round(cm / 2.54)
    return f"{total // 12}′{total % 12}″"


def inches(cm: float) -> str:
    v = round(cm / 2.54 * 2) / 2
    return (f"{v:.1f}".rstrip("0").rstrip(".")) + "″"


def num(v) -> str:
    return f"{v:g}"


def build_stats(profile: dict) -> list[dict]:
    """Measurement cells for the comp-card grid: label, value, unit, and the imperial / US equivalent."""
    s = profile.get("stats", {})
    rows = []
    if s.get("height_cm"):
        rows.append({"label": "Height", "value": num(s["height_cm"]), "unit": "cm", "alt": feet_inches(s["height_cm"])})
    for key, label in (("chest_cm", "Chest"), ("waist_cm", "Waist"), ("hips_cm", "Hips"), ("inseam_cm", "Inseam"), ("collar_cm", "Collar")):
        if s.get(key):
            rows.append({"label": label, "value": num(s[key]), "unit": "cm", "alt": inches(s[key])})
    if s.get("suit_eu"):
        rows.append({"label": "Suit", "value": num(s["suit_eu"]), "unit": "EU", "alt": f"{num(s['suit_eu'] - 10)} US/UK"})
    if s.get("shoe_eu"):
        us = SHOE_US.get(math.floor(s["shoe_eu"]))
        rows.append({"label": "Shoes", "value": num(s["shoe_eu"]), "unit": "EU", "alt": f"{num(us)} US" if us else ""})
    if profile.get("draft"):  # show which measurements are still missing
        have = {r["label"] for r in rows}
        order = ["Height", "Chest", "Waist", "Suit", "Shoes"]
        rows += [{"label": lab, "value": "\u2014", "unit": "", "alt": "to be added", "todo": True} for lab in order if lab not in have]
        rows.sort(key=lambda r: order.index(r["label"]) if r["label"] in order else 99)
    return rows


def build_facts(profile: dict) -> list[dict]:
    facts = []
    for key, label in (("hair", "Hair"), ("eyes", "Eyes"), ("tattoos", "Tattoos"), ("base", "Based in"), ("born", "Born")):
        if profile.get(key):
            facts.append({"label": label, "value": str(profile[key])})
    for key, label in (("languages", "Languages"), ("skills", "Sports & skills")):
        if profile.get(key):
            facts.append({"label": label, "value": ", ".join(profile[key])})
    return facts


# League Gothic advance widths (em) for caps, used only to pre-size the masthead before the page script refines it.
_ADV = {"I": 0.2, "J": 0.3, "M": 0.52, "W": 0.56, " ": 0.16, "L": 0.33, "E": 0.35, "F": 0.34, "T": 0.36}


def est_width(text: str) -> float:
    return sum(_ADV.get(c, 0.40) for c in text.upper())


# ---------------------------------------------------------------- layout -> pages

def number_frames(layout: dict) -> dict:
    """Give every photo used in cover, stories and digitals its running frame number."""
    order, seen = [], set()

    def add(pid):
        if pid and pid not in seen:
            seen.add(pid)
            order.append(pid)

    add(layout["cover"]["photo"])
    add(layout.get("intro", {}).get("photo"))
    for story in layout["stories"]:
        for row in story["rows"]:
            for pid in row["photos"]:
                add(pid)
    for fr in layout.get("digitals", {}).get("frames", []):
        add(fr["photo"])
    return {pid: i + 1 for i, pid in enumerate(order)}


def print_pages(layout: dict) -> list[dict]:
    """Translate the stories into A4 pages: a chapter opener per story, then one page per row."""
    pages = []
    for story in layout["stories"]:
        rows = list(story["rows"])
        first = rows[0]
        opener_photo = first["photos"][0]
        rest = first["photos"][1:]
        pages.append({"kind": "opener", "story": story, "photos": [opener_photo]})
        if rest:
            pages.append({"kind": {1: "full", 2: "duo"}.get(len(rest), "trio"), "story": story, "photos": rest[:3]})
        for row in rows[1:]:
            n = len(row["photos"])
            kind = row.get("print") or {1: "full", 2: "duo", 3: "trio"}.get(n, "quad")
            pages.append({"kind": kind, "story": story, "photos": row["photos"][:4]})
    return pages


# ---------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default=str(HERE / "profile.example.json"))
    ap.add_argument("--layout", default=str(HERE / "layout.example.json"))
    ap.add_argument("--photos", default="photos")
    ap.add_argument("--out", default="dist")
    ap.add_argument("--no-mail", action="store_true", help="skip the small e-mail image set")
    args = ap.parse_args()

    profile = json.loads(Path(args.profile).read_text(encoding="utf-8"))
    layout = json.loads(Path(args.layout).read_text(encoding="utf-8"))
    out = Path(args.out)
    for sub in ("web", "print"):
        shutil.rmtree(out / sub, ignore_errors=True)

    photos = process_photos(layout, Path(args.photos), out, mail=not args.no_mail)
    frames = number_frames(layout)
    for pid, n in frames.items():
        photos[pid]["n"] = n
    first, last = profile["name"]["first"], profile["name"]["last"]
    ctx = {
        "p": profile, "L": layout, "photos": photos, "total": len(frames),
        "stats": build_stats(profile), "facts": build_facts(profile),
        "full_name": f"{first} {last}",
        "mast_em": max(est_width(first), est_width(last)),
        "pages": print_pages(layout),
        "preview": not all(m["real"] for m in photos.values()),
        "draft": bool(profile.get("draft")),
        "has_contact": any(profile.get("contact", {}).get(k) for k in ("email", "instagram", "phone")),
    }
    env = Environment(loader=FileSystemLoader(HERE / "templates"), autoescape=select_autoescape(["html", "j2"]),
                      trim_blocks=True, lstrip_blocks=True)
    env.filters["pad"] = lambda n: f"{int(n):02d}"

    frag = env.get_template("web.html.j2").render(**ctx)
    (out / "web" / "index.html").write_text(frag, encoding="utf-8")
    shell = ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
             '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
             "<style>body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style>"
             "</head><body>" + frag + "</body></html>")
    (out / "web" / "preview.html").write_text(shell, encoding="utf-8")
    for name in ("portfolio", "compcard"):
        html = env.get_template(f"{name}.html.j2").render(img_dir="img", **ctx)
        (out / "print" / f"{name}.html").write_text(html, encoding="utf-8")
        if not args.no_mail and name == "portfolio":
            html = env.get_template(f"{name}.html.j2").render(img_dir="img-mail", **ctx)
            (out / "print" / f"{name}-mail.html").write_text(html, encoding="utf-8")
    fold = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "Ä": "Ae", "Ö": "Oe", "Ü": "Ue", "ß": "ss", " ": "-"})
    slug = "".join(c for c in f"{first}-{last}".translate(fold) if c.isascii() and (c.isalnum() or c == "-"))
    (out / "build.json").write_text(json.dumps({"slug": slug, "photos": sorted(photos)}), encoding="utf-8")
    real = sum(1 for m in photos.values() if m["real"])
    print(f"built {len(photos)} photos ({real} real, {len(photos) - real} placeholders), {len(ctx['pages'])} story pages -> {out}")


if __name__ == "__main__":
    main()
