"""Procedural space sky for Planet Forge.

Outputs (relative to repo root):
  public/sky/milkyway.hdr   2048x1024 equirect RGBE (three.js EquirectangularReflectionMapping)
  public/sky/stars.bin      float32 [x,y,z,r,g,b] * N
  public/sky/manifest.json
  docs/sky_preview.jpg      tone-mapped preview with stars splatted

Run:  uv run python -I make_sky.py --seed 7  [--level 1.0] [--stars 15000]
"""
import argparse
import json
import os
import time

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, map_coordinates

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
W, H = 2048, 1024


# ---------------------------------------------------------------- geometry
def pixel_dirs(w=W, h=H):
    col = (np.arange(w) + 0.5) / w
    row = (np.arange(h) + 0.5) / h
    u = col[None, :]
    v = 1.0 - row[:, None]
    theta = (u - 0.5) * 2 * np.pi          # atan2(z, x)
    phi = (v - 0.5) * np.pi                # asin(y)
    cp = np.cos(phi)
    x = cp * np.cos(theta) + 0 * u
    z = cp * np.sin(theta) + 0 * u
    y = np.sin(phi) + 0 * u
    return np.stack([x, y, z], -1).astype(np.float32)


def dir_to_uv(d):
    u = np.arctan2(d[:, 2], d[:, 0]) / (2 * np.pi) + 0.5
    v = np.arcsin(np.clip(d[:, 1], -1, 1)) / np.pi + 0.5
    return u, v


def galactic_frame(rng, tilt_deg=60.0):
    """Returns (pole, e1 (to galactic centre), e2)."""
    az = rng.uniform(0, 2 * np.pi)
    t = np.radians(tilt_deg + rng.uniform(-4, 4))
    pole = np.array([np.sin(t) * np.cos(az), np.cos(t), np.sin(t) * np.sin(az)])
    ref = np.cross(pole, [0, 1, 0])
    ref /= np.linalg.norm(ref)
    ang = rng.uniform(0, 2 * np.pi)
    e1 = ref * np.cos(ang) + np.cross(pole, ref) * np.sin(ang)
    e2 = np.cross(pole, e1)
    return pole, e1, e2


# ---------------------------------------------------------------- 3D noise
class Noise3D:
    """Periodic lattice noise sampled by direction (no seams: it is 3D)."""

    def __init__(self, rng, n=64, smooth=0.8):
        g = rng.standard_normal((n, n, n)).astype(np.float32)
        if smooth:
            g = gaussian_filter(g, smooth, mode="wrap")
        g /= g.std()
        self.g, self.n = g, n

    def __call__(self, p, freq, offset=(0, 0, 0)):
        # p: (...,3) in [-1,1]; map onto lattice
        q = (p * freq + np.asarray(offset, np.float32)) * 0.5 * self.n
        c = [q[..., i].ravel() for i in range(3)]
        out = map_coordinates(self.g, c, order=1, mode="grid-wrap")
        return out.reshape(p.shape[:-1])


def fbm(noise, p, freq, octaves, gain=0.5, lac=2.03, ridged=False):
    s = np.zeros(p.shape[:-1], np.float32)
    a, tot = 1.0, 0.0
    for o in range(octaves):
        n = noise(p, freq, offset=(o * 13.1, o * 7.7, o * 3.3))
        if ridged:
            n = 1.0 - np.abs(n) * 0.9
            n = n * n
            n -= 0.5
        s += a * n
        tot += a
        a *= gain
        freq *= lac
    return s / tot


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


# ---------------------------------------------------------------- sky
def make_sky(rng, level, frame):
    pole, e1, e2 = frame
    d = pixel_dirs()
    t0 = time.time()
    nz = [Noise3D(rng, 64, 0.9) for _ in range(3)]
    nfine = Noise3D(rng, 320, 0.0)

    # galactic coordinates
    sb = d @ pole.astype(np.float32)
    b = np.arcsin(np.clip(sb, -1, 1))
    x1 = d @ e1.astype(np.float32)
    x2 = d @ e2.astype(np.float32)
    l = np.arctan2(x2, x1)
    cosang = x1  # cos of angle to galactic centre

    # domain-warped midline (meandering plane)
    wob = fbm(nz[0], d, 1.5, 4)
    bw = b + 0.07 * wob
    wob2 = fbm(nz[1], d, 4.0, 3)
    bwd = b + 0.05 * wob + 0.025 * wob2

    # large-scale cloudiness along the band
    cloud = fbm(nz[2], d, 2.2, 5)
    cl = 0.55 + 0.45 * np.tanh(cloud * 1.6)
    detail = fbm(nz[0], d, 9.0, 5)

    # vertical profile: thin disk + broad halo glow
    thin = np.exp(-(bw / 0.075) ** 2)
    broad = np.exp(-(bw / 0.22) ** 2)
    ang = np.arccos(np.clip(cosang, -1, 1))
    bulge = np.exp(-(ang / 0.55) ** 2) * np.exp(-(b / 0.20) ** 2)
    bulge_core = np.exp(-(ang / 0.22) ** 2) * np.exp(-(b / 0.14) ** 2)
    # brightness varies with longitude (centre side brighter)
    lon_gain = 0.55 + 0.45 * np.clip(cosang, -1, 1) * 0.5 + 0.25
    star_glow = (0.85 * thin * (0.55 + 0.9 * np.clip(cl + 0.35 * detail, 0.05, 2))
                 + 0.16 * broad * (0.4 + 0.6 * cl)) * lon_gain
    star_glow = star_glow + 0.7 * bulge + 0.8 * bulge_core

    # dust lanes: ridged absorption concentrated on the midline
    ridge = fbm(nz[1], d, 5.0, 5, ridged=True) + 0.5   # ~0..1
    ridge2 = fbm(nz[2], d, 13.0, 3, ridged=True) + 0.5
    lane_env = np.exp(-(bwd / 0.045) ** 2)
    lane_env2 = np.exp(-(bwd / 0.11) ** 2)
    dust = (lane_env * smoothstep(0.25, 0.85, ridge) * 1.5
            + lane_env2 * smoothstep(0.45, 0.95, ridge * 0.7 + ridge2 * 0.5) * 0.9
            + lane_env * 0.35)
    dust *= 0.6 + 0.8 * np.clip(cl, 0, 1)
    # rift: a stronger gap that fades along the band
    rift = np.exp(-(bwd / 0.045) ** 2) * smoothstep(-0.2, 0.6, fbm(nz[0], d, 1.2, 3) + 0.3)
    dust += 1.6 * rift
    trans = np.exp(-2.3 * dust)
    # fraction of stars behind the dust (some foreground light survives)
    trans = 0.03 + 0.97 * trans

    # unresolved stars: fine grain, clumped inside band
    f1 = nfine(d, 1.0)
    f2 = nfine(d, 1.9, offset=(5.3, 1.7, 9.1))
    grain = 1.0 + 0.16 * f1 + 0.10 * f2
    grain = np.clip(grain, 0.2, 2.2)
    mid = 1.0 + 0.30 * np.clip(detail, -1.5, 1.5)
    lum = star_glow * trans * grain * mid
    lum = np.clip(lum, 0, None)

    # colour: warm bulge, cool outer disk, dust reddening
    warm = np.array([1.00, 0.80, 0.52], np.float32)
    mid_c = np.array([0.95, 0.90, 0.82], np.float32)
    cool = np.array([0.72, 0.82, 1.00], np.float32)
    wb = np.clip(bulge * 1.2 + bulge_core, 0, 1)[..., None]
    outer = np.clip(0.5 - 0.5 * np.clip(cosang, -1, 1), 0, 1)[..., None] * (1 - wb)
    col = mid_c * (1 - wb) + warm * wb
    col = col * (1 - 0.55 * outer) + cool * 0.55 * outer
    red = np.clip(dust, 0, 2)[..., None] * 0.18
    col = col * np.array([1.0, 1.0, 1.0], np.float32) * np.exp(-red * np.array([0.0, 0.25, 0.7], np.float32))
    img = col * lum[..., None]
    img = gaussian_filter(img, (0.9, 0.9, 0), mode="wrap")

    # fainter overall sky glow (airglow-like floor + halo)
    floor = (0.0004 + 0.0004 * broad)[..., None] * np.array([0.8, 0.9, 1.0], np.float32)
    img = img * 0.085 + floor * 1.0     # band peak ~0.1 before `level`

    # nebulae
    cols = {
        "ha": np.array([1.0, 0.18, 0.28], np.float32),
        "oiii": np.array([0.10, 0.85, 0.75], np.float32),
        "refl": np.array([0.25, 0.45, 1.0], np.float32),
    }
    kinds = ["ha", "ha", "oiii", "refl", "ha", "refl", "oiii"]
    neb = np.zeros_like(img)
    for i, kind in enumerate(kinds):
        # centres: prefer near the band
        for _ in range(100):
            c = rng.standard_normal(3)
            c /= np.linalg.norm(c)
            if abs(c @ pole) < 0.45 or i >= 5:
                break
        rad = rng.uniform(0.22, 0.45)
        dx = d @ c.astype(np.float32)
        a = np.arccos(np.clip(dx, -1, 1))
        # anisotropic via warp
        wp = fbm(nz[i % 3], d, 3.0, 3)
        env = np.exp(-((a + 0.12 * wp) / rad) ** 2)
        shape = fbm(nz[(i + 1) % 3], d + 0.35 * wp[..., None], 4.5 + i * 0.4, 4)
        m = smoothstep(-0.15, 0.7, shape) * env
        filament = smoothstep(0.1, 0.9, fbm(nz[(i + 2) % 3], d + 0.5 * wp[..., None], 9.0, 4) + 0.5)
        m = m * (0.35 + 0.65 * filament)
        amp = rng.uniform(0.012, 0.03)
        if kind == "refl":
            amp *= 0.7
        neb += cols[kind] * (m * amp)[..., None] * np.clip(trans[..., None] * 1.5, 0, 1)
    img = img + neb
    img = np.clip(img * level, 0, None).astype(np.float32)
    print(f"sky computed in {time.time()-t0:.1f}s; max={img.max():.3f} "
          f"p50={np.percentile(img,50):.5f} p99={np.percentile(img,99):.4f}")
    return img


# ---------------------------------------------------------------- RGBE
def write_hdr(path, img):
    h, w, _ = img.shape
    m = img.max(-1)
    e = np.zeros_like(m, dtype=np.int32)
    ok = m > 1e-32
    mant, ex = np.frexp(np.where(ok, m, 1.0))
    scale = np.where(ok, mant * 256.0 / np.where(ok, m, 1.0), 0.0)
    rgbe = np.zeros((h, w, 4), np.uint8)
    rgbe[..., :3] = np.clip(img * scale[..., None], 0, 255).astype(np.uint8)
    rgbe[..., 3] = np.where(ok, ex + 128, 0).astype(np.uint8)
    with open(path, "wb") as f:
        f.write(b"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n")
        f.write(f"-Y {h} +X {w}\n".encode())
        f.write(rgbe.tobytes())  # flat (uncompressed) scanlines


# ---------------------------------------------------------------- stars
def blackbody_rgb(T):
    """Linear sRGB (luminance-normalised) of a blackbody; Planck x CIE (Wyman fit)."""
    lam = np.arange(380, 781, 5.0)
    def g(x, mu, s1, s2):
        s = np.where(x < mu, s1, s2)
        return np.exp(-0.5 * ((x - mu) / s) ** 2)
    xb = 1.056 * g(lam, 599.8, 37.9, 31.0) + 0.362 * g(lam, 442.0, 16.0, 26.7) - 0.065 * g(lam, 501.1, 20.4, 26.2)
    yb = 0.821 * g(lam, 568.8, 46.9, 40.5) + 0.286 * g(lam, 530.9, 16.3, 31.1)
    zb = 1.217 * g(lam, 437.0, 11.8, 36.0) + 0.681 * g(lam, 459.0, 26.0, 13.8)
    l = lam * 1e-9
    out = []
    for t in np.atleast_1d(T):
        B = 1.0 / (l ** 5 * (np.exp(1.4388e-2 / (l * t)) - 1))
        X, Y, Z = (B * xb).sum(), (B * yb).sum(), (B * zb).sum()
        r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z
        gg = -0.9689 * X + 1.8758 * Y + 0.0415 * Z
        b = 0.0557 * X - 0.2040 * Y + 1.0570 * Z
        rgb = np.clip(np.array([r, gg, b]) / Y, 0, None)
        out.append(rgb)
    return np.array(out)


def make_stars(rng, n, frame, bright):
    pole = frame[0]
    e1 = frame[1]
    # positions: rejection sampling for plane/bulge concentration
    pts = []
    have = 0
    while have < n:
        v = rng.standard_normal((n * 3, 3))
        v /= np.linalg.norm(v, axis=1, keepdims=True)
        b = np.arcsin(np.clip(v @ pole, -1, 1))
        ang = np.arccos(np.clip(v @ e1, -1, 1))
        w = 0.16 + 0.60 * np.exp(-(b / 0.28) ** 2) + 0.35 * np.exp(-(b / 0.09) ** 2) \
            + 0.5 * np.exp(-(ang / 0.7) ** 2) * np.exp(-(b / 0.35) ** 2)
        keep = rng.uniform(0, 1.6, len(v)) < w
        pts.append(v[keep])
        have += keep.sum()
    pos = np.concatenate(pts)[:n]
    # magnitudes: count grows 2.5x per magnitude -> pdf ~ 2.5^m on [0, M]
    M = 8.0
    k = np.log(2.5)
    u = rng.uniform(0, 1, n)
    m = np.log(1 + u * (np.exp(k * M) - 1)) / k
    inten = bright * 2.512 ** (-m)
    inten *= np.exp(rng.normal(0, 0.08, n))
    # temperatures: log-normal around ~5500K with hot/cool tails
    T = np.exp(rng.normal(np.log(5400), 0.30, n))
    hot = rng.uniform(0, 1, n) < 0.07
    T[hot] = np.exp(rng.uniform(np.log(9000), np.log(30000), hot.sum()))
    cool = rng.uniform(0, 1, n) < 0.06
    T[cool] = np.exp(rng.uniform(np.log(2500), np.log(3800), cool.sum()))
    T = np.clip(T, 2500, 30000)
    # table lookup for speed
    grid = np.exp(np.linspace(np.log(2500), np.log(30000), 200))
    tab = blackbody_rgb(grid)
    idx = np.clip(np.searchsorted(grid, T), 0, 199)
    rgb = tab[idx]
    rgb = rgb / rgb.max(1, keepdims=True) * 0.55 + 0.45 * rgb / np.maximum(rgb[:, 1:2], 1e-6) * 0.0
    rgb = tab[idx]  # luminance-normalised
    lumn = rgb @ np.array([0.2126, 0.7152, 0.0722])
    rgb = rgb / np.maximum(lumn, 1e-6)[:, None]
    # soften saturation a touch so extremes don't look neon
    rgb = 0.15 + 0.85 * rgb
    return pos.astype(np.float32), (rgb * inten[:, None]).astype(np.float32)


# ---------------------------------------------------------------- preview
def aces(x):
    a, b, c, d, e = 2.51, 0.03, 2.43, 0.59, 0.14
    return np.clip((x * (a * x + b)) / (x * (c * x + d) + e), 0, 1)


def srgb(x):
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(np.clip(x, 0, None), 1 / 2.4) - 0.055)


def preview(path, img, pos, scol, exposure):
    im = img.copy()
    u, v = dir_to_uv(pos)
    inten = scol.max(1)
    sel = inten > 0.3
    px = u[sel] * W - 0.5
    py = (1 - v[sel]) * H - 0.5
    for x, y, c in zip(px, py, scol[sel]):
        # footprint widens with brightness (mimics bloom)
        s = 0.7 + 0.22 * np.log2(1 + c.max())
        r = int(np.ceil(3 * s))
        xs = np.arange(int(x) - r, int(x) + r + 1)
        ys = np.arange(int(y) - r, int(y) + r + 1)
        yy, xx = np.meshgrid(ys, xs, indexing="ij")
        g = np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * s * s))
        g /= (2 * np.pi * s * s)
        ok = (yy >= 0) & (yy < H)
        im[yy[ok], xx[ok] % W] += (g[ok][:, None] * c) * 2.0
    out = (srgb(aces(im * exposure)) * 255 + 0.5).astype(np.uint8)
    Image.fromarray(out).save(path, quality=92)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--level", type=float, default=1.0, help="HDR background intensity multiplier")
    ap.add_argument("--stars", type=int, default=15000)
    ap.add_argument("--star-peak", type=float, default=30.0, help="intensity of the brightest star")
    ap.add_argument("--exposure", type=float, default=5.0, help="preview exposure only")
    ap.add_argument("--tilt", type=float, default=60.0)
    a = ap.parse_args()
    rng = np.random.default_rng(a.seed)
    frame = galactic_frame(rng, a.tilt)
    out = os.path.join(ROOT, "public", "sky")
    docs = os.path.join(ROOT, "docs")
    os.makedirs(out, exist_ok=True)
    os.makedirs(docs, exist_ok=True)

    img = make_sky(rng, a.level, frame)
    write_hdr(os.path.join(out, "milkyway.hdr"), img)
    pos, col = make_stars(rng, a.stars, frame, a.star_peak)
    rec = np.concatenate([pos, col], 1).astype("<f4")
    rec.tofile(os.path.join(out, "stars.bin"))
    with open(os.path.join(out, "manifest.json"), "w") as f:
        json.dump({"count": int(len(pos)), "hdr": "milkyway.hdr", "stars": "stars.bin",
                   "galacticPole": [float(x) for x in frame[0]], "seed": a.seed}, f, indent=2)
    preview(os.path.join(docs, "sky_preview.jpg"), img, pos, col, a.exposure)
    print("done")


if __name__ == "__main__":
    main()
