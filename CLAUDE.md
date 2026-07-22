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

**Every endpoint is wrapped in `withSentry()`** from `_sentry.js`. Don't add new endpoints without it.

**Pro gate:** `isProUser(req)` in `_auth.js` reads `user_subscriptions.status` from Supabase. Pro users skip the analyze rate limit entirely. AirFryer/Thermomix in `recipes.js` is Pro-only and enforced server-side.

**Rate limits (free users):**
- `/api/analyze` — 3 per 7 days per IP
- `/api/recipes` — 30 per day per IP
- `/api/chat` — 50 per day per IP

**Stripe webhook** (`api/stripe/webhook.js`) requires raw body — Vercel's body parser is disabled via `module.exports.config = { api: { bodyParser: false } }`. Do not change this.

**Spoonacular** is only called in `recipes.js` when `appliance` is `airfryer` or `thermomix`. Results are cached in Upstash Redis with 24h TTL.

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
| Sentry | Error tracking (pending setup) | sentry.io |
