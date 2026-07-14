# Kompassen — agent notes

## Domains

- **https://kompassen.dev** is the primary, public-facing domain. This is the one shared with users and the one that should be indexed by search engines (canonical URLs, sitemap, Open Graph tags all point here).
- **https://kompassen.men** redirects to kompassen.dev. The GitHub Pages `CNAME` file still contains `kompassen.men`; do not change it without checking the DNS setup.

## Site structure

- Static site served via GitHub Pages from the repo root (`index.html`, `styles.css`, `app.js`, `i18n.js`).
- Single-page app with hash tabs: `#portfolio`, `#history`, `#personal`.
- CV page at `cv/index.html`.
- `predictions/` contains daily forecast JSON files written by the pipeline. Never edit or commit changes to these by hand — their untouched GitHub timestamps are the public proof that forecasts were made in advance.
- `index2.html`, `styles2.css`, `cv/index2.html` are local design experiments; keep them out of commits.

## Conventions

- Bump the `?v=` cache-busting query parameters in `index.html` when changing `styles.css`, `app.js`, or `i18n.js`.
- All user-visible text lives in `i18n.js` (English + Swedish); keep both languages in sync.
