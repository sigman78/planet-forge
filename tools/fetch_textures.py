"""Planet Forge offline texture pipeline.

Run from D:\\non-esp\\planet-forge\\tools:   uv run python -I fetch_textures.py [--force] [--layers a,b]

Downloads CC0 PBR sets (cached under tools/raw/<source>_<id>/), packs them into
public/textures/ per CONTRACT.md section 4, synthesizes the water normal map,
and writes manifest.json, ATTRIBUTION.md and docs/textures_preview.jpg.

Downloaded files are untrusted: zips are extracted into their own directory with a
zip-slip guard, only image members are extracted, and only decoded through Pillow.
"""
from __future__ import annotations

import argparse
import json
import sys
import zipfile
from pathlib import Path

import numpy as np
import requests
from PIL import Image, ImageDraw

# --------------------------------------------------------------------------------------
# EDIT HERE: layer -> asset.  (index order is fixed by src/core/types.ts)
# tileMeters = real-world size of one tile (ambientCG dimensionX is in cm but is 0 for
# many sets, so it is set explicitly here).
# --------------------------------------------------------------------------------------
LAYERS = [
    # index, name,         source,       id,           tileMeters
    (0, "beach_sand", "ambientCG", "Ground080",   1.5),
    (1, "grass",      "ambientCG", "Grass006",   2.0),
    (2, "forest",     "ambientCG", "Moss004",    1.5),
    (3, "dry_grass",  "ambientCG", "Ground072",  1.75),
    (4, "desert",     "ambientCG", "Ground097",  2.5),
    (5, "rock",       "ambientCG", "Rock060",    4.0),
    (6, "gravel",     "ambientCG", "Gravel024",  1.5),
    (7, "snow",       "ambientCG", "Snow010A",   3.0),
]
RES = 1024
PREFERRED_SIZES = ["2K-JPG", "1K-JPG"]
UA = {"User-Agent": "planet-forge-asset-tool/0.1 (+offline texture packer; CC0 sources)"}

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
RAW = HERE / "raw"
OUT = ROOT / "public" / "textures"
DOCS = ROOT / "docs"
IMG_EXT = {".jpg", ".jpeg", ".png"}


# ------------------------------------------------------------------ download / extract
def acg_info(asset_id: str) -> dict:
    r = requests.get(
        "https://ambientcg.com/api/v2/full_json",
        params={"id": asset_id, "include": "downloadData,dimensionsData"},
        headers=UA, timeout=60)
    r.raise_for_status()
    for a in r.json()["foundAssets"]:
        if a["assetId"] == asset_id:
            return a
    raise RuntimeError(f"ambientCG asset not found: {asset_id}")


def acg_pick_download(info: dict) -> dict:
    dls = info["downloadFolders"]["default"]["downloadFiletypeCategories"]["zip"]["downloads"]
    by_attr = {d["attribute"]: d for d in dls}
    for want in PREFERRED_SIZES:
        if want in by_attr:
            return by_attr[want]
    raise RuntimeError(f"no {PREFERRED_SIZES} download for {info['assetId']}: {list(by_attr)}")


def safe_extract_images(zpath: Path, dest: Path) -> list[Path]:
    """Extract image members only, flattened, with zip-slip guard."""
    dest_r = dest.resolve()
    out = []
    with zipfile.ZipFile(zpath) as z:
        for m in z.infolist():
            if m.is_dir():
                continue
            name = Path(m.filename.replace("\\", "/")).name  # flatten: drops any ../ parts
            if not name or Path(name).suffix.lower() not in IMG_EXT:
                continue
            target = (dest / name).resolve()
            if dest_r not in target.parents:
                print(f"  skipping suspicious member {m.filename!r}")
                continue
            if m.file_size > 200 * 1024 * 1024:
                print(f"  skipping oversize member {m.filename!r}")
                continue
            with z.open(m) as src, open(target, "wb") as dst:
                while chunk := src.read(1 << 20):
                    dst.write(chunk)
            out.append(target)
    return out


def fetch_acg(asset_id: str) -> tuple[dict, Path]:
    d = RAW / f"ambientCG_{asset_id}"
    meta_p = d / "meta.json"
    xdir = d / "x"
    if meta_p.exists() and xdir.exists() and any(xdir.iterdir()):
        return json.loads(meta_p.read_text()), xdir
    d.mkdir(parents=True, exist_ok=True)
    info = acg_info(asset_id)
    dl = acg_pick_download(info)
    print(f"  downloading {dl['fileName']} ({dl['size'] / 1e6:.1f} MB)")
    zpath = d / dl["fileName"]
    with requests.get(dl["downloadLink"], headers=UA, timeout=300, stream=True) as r:
        r.raise_for_status()
        with open(zpath, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
    xdir.mkdir(exist_ok=True)
    files = safe_extract_images(zpath, xdir)
    print("  extracted:", ", ".join(p.name for p in files))
    meta = {"assetId": asset_id, "attribute": dl["attribute"], "url": info.get("shortLink"),
            "dimensionX_cm": info.get("dimensionX"), "dimensionY_cm": info.get("dimensionY")}
    meta_p.write_text(json.dumps(meta, indent=1))
    return meta, xdir


# ------------------------------------------------------------------------ image helpers
def find_map(xdir: Path, asset_id: str, suffix: str) -> Path | None:
    """Match <asset>_<res>-JPG_<suffix>.<ext> style names by suffix, case-insensitive."""
    suffix = suffix.lower()
    for p in sorted(xdir.iterdir()):
        if p.suffix.lower() in IMG_EXT and p.stem.lower().endswith("_" + suffix):
            return p
    return None


def load(p: Path, mode: str) -> np.ndarray:
    im = Image.open(p)
    im.load()
    return np.asarray(im.convert(mode), dtype=np.float32) / 255.0


def resize(a: np.ndarray, res: int = RES) -> np.ndarray:
    """LANCZOS resize of a float (H,W[,C]) 0..1 array; works per channel in float."""
    if a.shape[0] == res and a.shape[1] == res:
        return a
    chans = [a] if a.ndim == 2 else [a[..., i] for i in range(a.shape[2])]
    out = [np.asarray(Image.fromarray(c, mode="F").resize((res, res), Image.LANCZOS)) for c in chans]
    r = out[0] if a.ndim == 2 else np.stack(out, -1)
    return np.clip(r, 0.0, 1.0)


def srgb_to_lin(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def save_jpg(a: np.ndarray, path: Path, q: int, gray: bool = False) -> None:
    u8 = np.clip(np.rint(a * 255.0), 0, 255).astype(np.uint8)
    Image.fromarray(u8, mode="L" if gray else "RGB").save(path, quality=q, subsampling=0)


def renorm_normal(n: np.ndarray) -> np.ndarray:
    v = n * 2.0 - 1.0
    v[..., 2] = np.maximum(v[..., 2], 1e-3)
    v /= np.linalg.norm(v, axis=-1, keepdims=True)
    return v * 0.5 + 0.5


# ------------------------------------------------------------------------- layer packing
def pack_layer(idx: int, name: str, source: str, asset_id: str, tile_m: float) -> dict:
    print(f"[{idx}] {name}: {source}/{asset_id}")
    if source != "ambientCG":
        raise NotImplementedError(source)
    meta, xdir = fetch_acg(asset_id)

    color = resize(load(find_map(xdir, asset_id, "Color"), "RGB"))
    save_jpg(color, OUT / f"{name}_albedo.jpg", 90)

    p = find_map(xdir, asset_id, "NormalGL")
    if p is not None:
        nrm = load(p, "RGB")
    else:  # only DX available: flip green
        nrm = load(find_map(xdir, asset_id, "NormalDX"), "RGB")
        nrm[..., 1] = 1.0 - nrm[..., 1]
    nrm = renorm_normal(resize(nrm))
    save_jpg(nrm, OUT / f"{name}_normal.jpg", 95)

    def opt(sfx):
        p = find_map(xdir, asset_id, sfx)
        return resize(load(p, "L")) if p else None

    ao, rough, metal, disp = opt("AmbientOcclusion"), opt("Roughness"), opt("Metalness"), opt("Displacement")
    if rough is None:
        rough = np.full((RES, RES), 0.85, np.float32)
        print("  (no roughness map, using 0.85)")
    orm = np.stack([ao if ao is not None else np.ones_like(rough), rough,
                    metal if metal is not None else np.zeros_like(rough)], -1)
    save_jpg(orm, OUT / f"{name}_orm.jpg", 92)

    if disp is None:
        print("  (no displacement map, deriving height from albedo luminance)")
        disp = color @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    lo, hi = np.percentile(disp, [0.2, 99.8])
    disp = np.clip((disp - lo) / max(hi - lo, 1e-6), 0, 1)
    save_jpg(disp, OUT / f"{name}_height.jpg", 92, gray=True)

    # use what the renderer will actually load (JPEG round trip) for the stats
    mean_lin = srgb_to_lin(np.asarray(Image.open(OUT / f"{name}_albedo.jpg").convert("RGB"), np.float32) / 255).mean((0, 1))
    mean_r = float(np.asarray(Image.open(OUT / f"{name}_orm.jpg").convert("RGB"), np.float32)[..., 1].mean() / 255)
    return {
        "index": idx, "name": name, "source": f"{source}/{asset_id}",
        "url": meta.get("url") or f"https://ambientcg.com/a/{asset_id}", "license": "CC0",
        "albedo": f"{name}_albedo.jpg", "normal": f"{name}_normal.jpg",
        "orm": f"{name}_orm.jpg", "height": f"{name}_height.jpg",
        "tileMeters": tile_m,
        "meanAlbedo": [round(float(x), 4) for x in mean_lin],
        "meanRoughness": round(mean_r, 4),
    }


# ----------------------------------------------------------------------- water synthesis
def synth_water_normal(res: int = RES, seed: int = 7) -> np.ndarray:
    """Tileable ocean-like normal map: random-phase waves from a directional FFT spectrum.
    Periodic by construction (spectral synthesis + spectral derivatives)."""
    rng = np.random.default_rng(seed)
    k1 = np.fft.fftfreq(res, 1.0 / res)  # integer cycles per tile
    kx, ky = np.meshgrid(k1, k1, indexing="xy")
    k = np.hypot(kx, ky)
    k[0, 0] = 1.0
    kmin, kmax = 3.0, 140.0
    # Phillips-like wind spectrum with two wind directions for a less regular look
    spec = np.zeros_like(k)
    for ang, wgt in ((0.35, 1.0), (2.2, 0.55)):
        w = np.array([np.cos(ang), np.sin(ang)])
        cosang = (kx * w[0] + ky * w[1]) / k
        L = 18.0
        s = np.exp(-1.0 / (k / L) ** 2) / k ** 4 * np.abs(cosang) ** 2
        s += 0.05 * np.exp(-1.0 / (k / L) ** 2) / k ** 4  # omnidirectional floor
        spec += wgt * s
    spec *= np.exp(-(k / kmax) ** 2) * (k >= kmin)
    spec[0, 0] = 0
    h_hat = (rng.normal(size=k.shape) + 1j * rng.normal(size=k.shape)) * np.sqrt(spec)
    # slopes via spectral derivatives (units: per tile, scaled later)
    dx = np.fft.ifft2(1j * 2 * np.pi * kx * h_hat).real
    dy = np.fft.ifft2(1j * 2 * np.pi * ky * h_hat).real
    sd = np.sqrt((dx ** 2 + dy ** 2).mean())
    target = 0.35  # rms slope -> visibly rippled but not chaotic
    dx *= target / sd
    dy *= target / sd
    n = np.stack([-dx, -dy, np.ones_like(dx)], -1)  # OpenGL: +Y up, green = +dh/dy flipped sign convention
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return (n * 0.5 + 0.5).astype(np.float32)


# ------------------------------------------------------------------------ contact sheet
def contact_sheet(layers: list[dict]) -> None:
    cell, lab = 256, 18
    cols = len(layers) + 1
    sheet = Image.new("RGB", (cell * cols, (cell + lab) * 2), (24, 24, 24))
    d = ImageDraw.Draw(sheet)
    names = [(l["name"], l["albedo"], l["normal"], l["source"].split("/")[1]) for l in layers]
    names.append(("water", None, "water_normal.jpg", "synthesized"))
    for i, (n, alb, nor, src) in enumerate(names):
        x = i * cell
        for row, f in enumerate((alb, nor)):
            y = row * (cell + lab)
            if f is None:
                im = Image.new("RGB", (cell, cell), (14, 60, 80))
            else:
                big = Image.open(OUT / f).convert("RGB")
                # 2x2 tiling shows seams / repetition
                t = big.resize((cell // 2, cell // 2), Image.LANCZOS)
                im = Image.new("RGB", (cell, cell))
                for a in range(2):
                    for b in range(2):
                        im.paste(t, (a * cell // 2, b * cell // 2))
            sheet.paste(im, (x, y + lab))
            d.text((x + 3, y + 3), f"{n} {'albedo' if row == 0 else 'normal'} [{src}]", fill=(255, 255, 0))
    DOCS.mkdir(exist_ok=True)
    sheet.save(DOCS / "textures_preview.jpg", quality=88)


def write_attribution(layers: list[dict]) -> None:
    lines = ["# Texture attribution", "",
             "All terrain textures are CC0 1.0 (public domain) from ambientCG (https://ambientcg.com).",
             "Thank you to ambientCG and its contributors for making these freely available.", "",
             "| Layer | Asset | Source URL | License |", "|---|---|---|---|"]
    for l in layers:
        lines.append(f"| {l['name']} | {l['source']} | {l['url']} | CC0 |")
    lines.append("| water_normal | synthesized (FFT ocean spectrum, tools/fetch_textures.py) | n/a | CC0 / own work |")
    lines.append("")
    (OUT / "ATTRIBUTION.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--layers", help="comma list of layer names (default all)")
    args = ap.parse_args()
    only = set(args.layers.split(",")) if args.layers else None
    OUT.mkdir(parents=True, exist_ok=True)
    RAW.mkdir(exist_ok=True)

    layers = []
    for idx, name, src, aid, tm in LAYERS:
        if only and name not in only:
            continue
        layers.append(pack_layer(idx, name, src, aid, tm))
    if only:
        print("partial run: manifest/preview not rewritten")
        return 0

    print("water normal (synthesized)")
    save_jpg(synth_water_normal(), OUT / "water_normal.jpg", 95)
    manifest = {
        "resolution": RES, "layers": layers,
        "water": {"normal": "water_normal.jpg", "source": "synthesized (FFT ocean spectrum, tools/fetch_textures.py)",
                  "license": "CC0", "tileMeters": 12.0},
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    write_attribution(layers)
    contact_sheet(layers)
    total = sum(p.stat().st_size for p in OUT.iterdir())
    print(f"done. public/textures = {total / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
