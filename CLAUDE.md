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

There are no tests, linter, or CI configured.

## Architecture

```
index.html          Landing page (SEO, waitlist, Stripe CTA)
app.html            Main app (~5000 lines, single file, vanilla JS)
api/
  _auth.js          isProUser(req) — checks Supabase user_subscriptions
  _ratelimit.js     rateLimit() — Upstash Redis sliding window
  _sentry.js        withSentry(handler) — wraps all endpoints
  analyze.js        POST /api/analyze — GPT-4o Vision, detects ingredients
  recipes.js        POST /api/recipes — GPT-4o, generates 3 recipes
  chat.js           POST /api/chat — GPT-4o-mini, chef assistant
  waitlist.js       POST /api/waitlist — email capture to Supabase
  stripe/
    checkout.js     POST /api/stripe/checkout — creates Stripe session
    webhook.js      POST /api/stripe/webhook — updates user_subscriptions
    status.js       GET  /api/stripe/status — returns subscription status
    portal.js       POST /api/stripe/portal — opens billing portal
```

## Key patterns

**Every endpoint is wrapped in `withSentry()`** from `_sentry.js`. Don't add new endpoints without it. `withSentry` only catches *uncaught* exceptions — if a handler catches an error itself (e.g. Stripe/Supabase errors that return a 4xx/5xx to the client), also call `captureError(err, {context})` from `_sentry.js` so it reaches Sentry.

**Pro gate:** `isProUser(req)` in `_auth.js` reads `user_subscriptions.status` from Supabase. Pro users skip the analyze rate limit entirely. AirFryer/Thermomix in `recipes.js` and the chef chat in `chat.js` are Pro-only and enforced server-side.

**Rate limits (free users):**
- `/api/analyze` — 3 per 7 days per IP
- `/api/recipes` — 30 per day per IP
- `/api/chat` — 50 per day per IP

**Stripe webhook** (`api/stripe/webhook.js`) requires raw body — Vercel's body parser is disabled via `module.exports.config = { api: { bodyParser: false } }`. Do not change this.

**Spoonacular** is only called in `recipes.js` when `appliance` is `airfryer` or `thermomix`. Results are cached in Upstash Redis with 24h TTL.

**CDN cache on HTML:** `vercel.json` pins `/`, `/app`, `*.html`, `/manifest.json` and `/sw.js` to `s-maxage=60` (and `sw.js` to `s-maxage=0`). Without this the Vercel edge cache holds stale HTML for days after a deploy — do not remove.

## Frontend

`app.html` is a single ~5700-line file with three `:root` blocks stacked in one `<style>`: an original light-green block (line ~41), a "Redesign 2.0" warm block (line ~2103), and the **Dark Premium** block (line ~2363) that wins the cascade. When adjusting colors, edit the Dark Premium block — the earlier ones are dead but still there because 2300+ lines of CSS in between hardcode individual overrides that would break if the tokens vanished.

The landing (`index.html`) uses the same palette (`#00C896` / `#F97316` / `#0F1117` / `#1A1D27` / `#F0F2F5` / `#8B949E`) as loose vars declared inline in its `<style>`.

## PWA icons

Icons live in `/assets/` and are versioned in the URL (`icon-180-v2.png`, `icon-192-v2.png`, `icon-512-v2.png`) because iOS caches `apple-touch-icon` by URL and ignores manifest refreshes. Any icon redesign requires bumping the suffix everywhere — otherwise iPhones that have already visited the site keep serving the old icon indefinitely.

To regenerate the PNGs from `assets/logo.svg`, install `sharp` temporarily (`npm install --no-save sharp`) and run a one-shot Node script that calls `sharp(svg, { density: 400 }).resize(size, size).png().toFile(...)` for each size. After generating, delete the temp `node_modules/sharp` / `@img` folders — sharp is not a runtime dep. Bump `CACHE` version in `sw.js` in the same commit.

## Analytics (PostHog)

Events tracked in `app.html`: `photo_analyzed`, `recipes_generated`, `recipe_saved`, `recipe_unsaved`, `chat_opened`, `user_signed_in`. Anonymous users are tracked by device ID; on Google sign-in, PostHog identifies the user so all past events attach to the account.

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
| Stripe | Pro subscriptions (€3.99/mo) | dashboard.stripe.com |
| Upstash Redis | Rate limiting + Spoonacular cache | upstash.com |
| PostHog | Analytics | posthog.com (project key: phc_yoR4Z9wD2moKZKKvdYsan9dmuyut74crAVxyeAidonKF) |
| Sentry | Error tracking (active) | sentry.io |
