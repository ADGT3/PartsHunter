# PartsHunter — Porsche 992 GT3 RS Weekly Parts Watch

A weekly, auto-refreshed web page that trawls the internet for OEM Porsche 992 GT3 RS
parts for sale (front-end collision rebuild: front end, airbag-affected interior with
red stitching, and left-front suspension). Built for front-end collision sourcing.

## Live site

Hosted on Vercel (connected to this GitHub repo): every push auto-deploys.

- `index.html` — the **current** week (always the latest listings)
- `archive.html` — index of **every past week**, newest first
- `weeks/YYYY-MM-DD.html` — a permanent dated snapshot saved each Friday

## How the weekly update works

1. A scheduled task runs every **Friday morning**.
2. It searches the web for matching OEM listings and pulls product images.
3. It writes a new snapshot at `weeks/<friday-date>.html`.
4. It overwrites `index.html` with that same content (so the top-level URL is always current).
5. It adds a new row to `archive.html`.
6. It commits and pushes to `main` — Vercel redeploys automatically.

## Scope of parts tracked

- **Front end:** bumper cover, front fenders (L+R), hood, headlights, and front-end
  lining/attachment pieces.
- **Interior (airbag-affected):** 992.1 / 992.2 carbon sports seats **with red stitching**,
  dash/knee airbag components, steering wheel airbag, seatbelts/pretensioners.
- **Left-front suspension:** control arms, links, knuckle, ball joints, camber hardware.

## Notes

- Product images are hotlinked from source listings; they may stop displaying if a listing
  is removed. Prices/availability change fast — confirm fitment and airbag/sensor
  compatibility with each seller before purchase.
- Not affiliated with Porsche AG. "Porsche" and "GT3 RS" are used for identification only.
