# Zorbi customer-lookup proxy

A minimal Express server whose only job is to hide the CRM's secret API key
(`X-Api-Key`) for one endpoint: customer phone lookup. Everything else
(zones, admission plans) is called directly from the browser in
`assets/js/booking.js` using the publishable tenant key, which is safe
client-side.

## Requirements

- Node.js 18+ (uses the built-in `fetch`)

## Run it locally

```
npm install
npm start
```

The server listens on `PORT` (default `4000`) and exposes one route:

```
GET /api/customer-lookup?phone=<phone>
```

## Required environment variables (`.env`)

| Variable          | Description                                                            |
| ----------------- | ----------------------------------------------------------------------- |
| `CRM_BASE_URL`     | Base URL of the CRM API, e.g. `https://api.example.com`                |
| `CRM_SECRET_KEY`   | The CRM's secret `sk_live_...` key. **Server-side only.**               |
| `ALLOWED_ORIGIN`   | The single origin allowed to call this proxy (your live site's origin) |
| `PORT`             | Port to listen on (default `4000`)                                     |

Copy `.env.example` to `.env` and fill in real values before running.

## Important

`CRM_SECRET_KEY` must never be committed to git or exposed to client-side
code. `.env` is already gitignored — keep it that way, and don't put the
secret key anywhere in `assets/js/booking.js` or any other file served to
the browser.
