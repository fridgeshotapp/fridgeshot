# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

FridgeShot is a PWA that analyzes fridge photos with GPT-4o Vision and generates personalized recipes. Live at fridgeshot.app. No framework, no build step — vanilla JS frontend + Vercel serverless Node.js backend.

## Deploy

```bash
git push origin   # triggers auto-deploy on Vercel
```

Do NOT run `git push origin master` — Vercel's Production Branch is `main`, not `master`, and the Vercel REST API does not expose a way to change it. Instead, the local git config has a dual refspec configured:

```
[remote "origin"]
  push = refs/heads/master:refs/heads/master
  push = refs/heads/master:refs/heads/main
```

So `git push origin` (with no args) pushes `master` up as **both** `master` (preview) and `main` (production) in one shot. If you push with an explicit ref (`git push origin master`), only master goes up and production won't update.

To test API functions locally, install the Vercel CLI (`npm i -g vercel`) and run `vercel dev` — it reads `.env.local` for secrets.

There are no tests, linter, or CI configured. `test/` only holds sample fridge images for manual testing of `/api/analyze`.

## Architecture

```
index.html          Landing page (SEO, waitlist) — no pricing/Pro shown
app.html            Main app (~5800 lines, single file, vanilla JS)
404.html, privacidad.html, terminos.html   Static pages (/privacidad, /terminos via rewrites)
manifest.json, sw.js                       PWA manifest + service worker
assets/             Served in production (icons, logo, og-image, supabase.min.js)
api/
  _auth.js          isProUser(req)
  _ratelimit.js     rateLimit() — Upstash Redis sliding window (fail-open: Redis down/slow >2s → request allowed + Sentry)
  _openai.js        openaiPost()/chatJSON() — ALL OpenAI calls go through here (per-attempt timeout, retries on 429/5xx/network, fallback model on 404, shared deadline)
  _sentry.js        withSentry(handler) — wraps all endpoints
  analyze.js        POST /api/analyze — GPT-4o Vision, detects ingredients
  recipes.js        POST /api/recipes — GPT-4o, generates 3 recipes
  chat.js           POST /api/chat — GPT-4o-mini, chef assistant
  image.js          POST /api/image — gpt-image-1-mini (fallback gpt-image-1, dall-e-3), returns JPEG b64
  waitlist.js       POST /api/waitlist — email capture to Supabase
  keepalive.js      GET  /api/keepalive — daily Vercel cron, pings Supabase + Upstash so free-tier projects are not paused/archived (both died from inactivity in Oct 2026)
  stripe/           checkout, webhook, status, portal (dormant, see below)
docs/               SERVICIOS.md (what each external service is + cost), guion-video-ads.md
marketing/          Non-deployed marketing material (see Marketing)
```

`vercel.json` sets `maxDuration` 60s for analyze/recipes/image, 30s for chat, 15s for the Stripe webhook. Timeouts must stay ordered: OpenAI deadline in the handler (52-55s) < `maxDuration` < client `API_TIMEOUTS` in `app.html` (65s) < loading-screen safety timeout (75s). If you change one, check the others.

Models are overridable without code changes via `OPENAI_MODEL_VISION`, `OPENAI_MODEL_RECIPES`, `OPENAI_MODEL_CHAT`, `OPENAI_MODEL_IMAGE` (comma-separated, tried before the defaults in `MODELS` in `_openai.js`).

## Key patterns

**Every endpoint is wrapped in `withSentry()`** from `_sentry.js`. Don't add new endpoints without it. `withSentry` only catches *uncaught* exceptions — if a handler catches an error itself (e.g. Stripe/Supabase errors that return a 4xx/5xx to the client), also call `captureError(err, {context})` from `_sentry.js` so it reaches Sentry.

**Pro gate:** `_auth.js` currently returns `true` for all users — all features unlocked. Do not add Pro gates without reverting this first.

**Stripe / Pro (€3.99/mo) is dormant, not removed** — endpoints, env vars and the `user_subscriptions` table stay because it will be reactivated. The landing shows no pricing, so nothing user-facing (copy, marketing) may promise paid features until then.

**Rate limits (per IP, `rateLimit()` is a no-op if `UPSTASH_REDIS_REST_URL` is unset):**
- `/api/analyze` — 3 per 7 days, but skipped for Pro users → currently **unlimited** because `isProUser()` is always true
- `/api/recipes` — 30 per day
- `/api/chat` — 50 per day
- `/api/image` — 5 per day
- `/api/waitlist` — 5 per hour

**Stripe webhook** (`api/stripe/webhook.js`) requires raw body — Vercel's body parser is disabled via `module.exports.config = { api: { bodyParser: false } }`. Do not change this.

**Spoonacular** is only called in `recipes.js` when `appliance` is `airfryer` or `thermomix`. Results are cached in Upstash Redis with 24h TTL.

**CDN cache on HTML:** `vercel.json` pins `/`, `*.html`, `/manifest.json` to `s-maxage=60`, `/app` to `s-maxage=0` (no CDN cache — stale edge responses caused the app to serve outdated JS), and `sw.js` to `s-maxage=0`. Do not raise `/app` above 0.

**Content-Security-Policy** is set in `vercel.json` for all routes. Any new external origin (script CDN, analytics, ad pixel like TikTok/Meta, image host, API) must be added to the matching CSP directive or the browser silently blocks it.

**Service worker** (`sw.js`, cache `fridgeshot-v12`): `/api/*` is network-only (returns a 503 JSON offline error), navigations are network-first, static files cache-first. Bump `CACHE` whenever a file in its `STATIC` list changes. The SW only handles same-origin requests — never route Supabase/Google/PostHog through it.

**Supabase auth callback must stay synchronous:** never make the `onAuthStateChange` callback `async` or `await` Supabase calls inside it — supabase-js runs it under its auth lock and any awaited `_supabase.from()`/`getSession()` deadlocks (login hangs, sync never ends). Defer work with `setTimeout(..., 0)` (see `onUserAvailable`). Auth uses `flowType: 'implicit'` on purpose (PKCE breaks when the OAuth return lands in a different browser context, e.g. iOS PWA → Safari). Google blocks OAuth inside in-app browsers (TikTok/Instagram) — `isInAppBrowser()` shows a hint instead.

**Supabase SDK is self-hosted** at `/assets/supabase.min.js` (loaded via `<script src="/assets/supabase.min.js">`). Do NOT switch back to the jsDelivr CDN — it gets blocked by corporate/strict network firewalls, causing `window.supabase` to be undefined and silently breaking all auth. To upgrade the SDK version, download the new UMD bundle from jsDelivr and replace the file.

**`window.onerror` diagnostic banner** is active in `app.html` — any uncaught JS error shows a red banner at the top of the screen. Keep it; it has caught real production issues.

## Frontend

`app.html` stacks several `:root` blocks in one `<style>`: the original light-green block (top of the style tag), the "FRIDGESHOT 2.0 — REDESIGN VISUAL" warm block, and the **"DARK PREMIUM THEME"** block (search for that comment) that wins the cascade. When adjusting colors, edit the Dark Premium block — the earlier ones are dead but still there because thousands of lines of CSS in between hardcode individual overrides that would break if the tokens vanished.

The landing (`index.html`) uses the same palette (`#00C896` / `#F97316` / `#0F1117` / `#1A1D27` / `#F0F2F5` / `#8B949E`) as loose vars declared inline in its `<style>`.

## Marketing (marketing/)

All marketing material lives in `marketing/` (`tiktok/`, `reddit/`), never in `/assets/` — that folder is deployed to production.

`marketing/tiktok/` is for short TikTok reels (in progress). Script: `docs/guion-video-ads.md` (hook = "no sé qué cocinar", close with "gratis, sin tarjeta"). Planned flow: AI hook clips generated manually in Kling 3.0 (free tier, no API — generate at klingai.com, save to `marketing/tiktok/assets/raw/`) + real app screen recordings + TTS narration (ElevenLabs) + captions, assembled with Remotion into 9:16 MP4.

## PWA icons

Icons live in `/assets/` and are versioned in the URL (`icon-180-v2.png`, `icon-192-v2.png`, `icon-512-v2.png`) because iOS caches `apple-touch-icon` by URL and ignores manifest refreshes. Any icon redesign requires bumping the suffix everywhere — otherwise iPhones that have already visited the site keep serving the old icon indefinitely.

To regenerate the PNGs from `assets/logo.svg`, install `sharp` temporarily (`npm install --no-save sharp`) and run a one-shot Node script that calls `sharp(svg, { density: 400 }).resize(size, size).png().toFile(...)` for each size. After generating, delete the temp `node_modules/sharp` / `@img` folders — sharp is not a runtime dep. Bump `CACHE` version in `sw.js` in the same commit.

## Analytics (PostHog)

Events tracked in `app.html` (via `capture(...)`): `app_opened`, `upload_screen_viewed`, `analyze_started`, `photo_analyzed`, `recipes_generated`, `recipe_detail_opened`, `recipe_saved`, `recipe_unsaved`, `recipe_shared`, `recipe_photo_generated`, `chat_opened`, `user_signed_in`, `pro_modal_opened`, `checkout_started`. Anonymous users are tracked by device ID; on Google sign-in, PostHog identifies the user so all past events attach to the account.

## Supabase tables

| Table | Purpose |
|---|---|
| `user_subscriptions` | Stripe subscription status per user (`active`, `trialing`, `cancelled`) |
| `saved_recipes` | Recipes favourited by users |
| `user_preferences` | Stored filter preferences (time, servings, diet, pantry) |
| `waitlist` | Email capture (upsert by email, rate-limited 5/h) |

## Environment variables

All must be set in Vercel dashboard (Settings → Environment Variables):

```
OPENAI_API_KEY
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_PRICE_ID         # price ID of the Pro €3.99 subscription
SPOONACULAR_API_KEY
SENTRY_DSN
```

## External services

| Service | What it does | Dashboard |
|---|---|---|
| Vercel | Hosting + serverless | vercel.com → fridgeshot |
| OpenAI | Vision + recipes (GPT-4o) + chat (GPT-4o-mini) | platform.openai.com |
| Supabase | Auth (Google OAuth) + DB | supabase.com → amniuriaesnvgagfjhre |
| Stripe | Pro subscriptions (€3.99/mo, dormant) | dashboard.stripe.com |
| Upstash Redis | Rate limiting + Spoonacular cache | upstash.com |
| Spoonacular | Airfryer/Thermomix recipes | spoonacular.com |
| PostHog | Analytics (EU host) | posthog.com (project key: phc_yoR4Z9wD2moKZKKvdYsan9dmuyut74crAVxyeAidonKF) |
| Sentry | Error tracking (active) | sentry.io |

## MCP servers (.mcp.json)

`.mcp.json` (gitignored — contains tokens, never commit it) configures: Supabase (read-only), GitHub, **Stripe with a live key and all tools**, Vercel, Sentry. Never run Stripe write operations (refunds, prices, customers, subscriptions) without explicit user confirmation.
