# Sky generator (tools/make_sky.py)
Run from tools/: `uv run python -I make_sky.py --seed 7` (~35 s). Outputs public/sky/{milkyway.hdr,stars.bin,manifest.json} and docs/sky_preview.jpg.

Technique: every pixel is a unit direction (three.js equirect convention); all noise is 3D lattice noise sampled by direction, so no seam at u=0/1 and no polar pinching.
Galactic plane = great circle tilted ~60 deg (orientation from seed); band = thin disk + halo gaussians in latitude, warped by fbm, brighter warm bulge toward the galactic centre, fine grain for unresolved stars,
ridged-fbm dust lanes + a central rift as absorption (with mild reddening), plus 7 domain-warped Halpha/OIII/reflection nebulae. Stars: 15000, count ~x2.5 per magnitude, concentrated on the plane,
blackbody colours (2500-30000K, median ~5400K), intensity 0.02..30.

Knobs: `--level` (HDR multiplier, default 1: band peak ~0.05-0.1, dark sky ~0.0007), `--stars`, `--star-peak`, `--tilt`, `--seed`, `--exposure` (preview only).
Viewer: scale background by ~1.0 (use backgroundIntensity as the live knob); stars.bin colours as-is, bloom handles the brightest.
