# Pixel service

The endpoint behind read receipts. A tracked message carries a 1x1 image pointing here; fetching it
records that something asked for the image.

**Read this before turning it on.** A pixel does not tell you that a person read your message. It
tells you that software requested an image. Gmail proxies images and many people block them, so a
message with no signal may well have been read. Apple Mail Privacy Protection fetches the image the
moment mail arrives whether or not anyone looks, which produces confident nonsense unless it is
filtered out. This service grades every fetch (`opened`, `automatic`, `unknown`) and reports "no
signal" rather than "unread", because the difference matters and most tools lie about it.

It also changes where your mail lives. Every tracked message causes one request from your recipient
to a server you run. That is a real thing to do to someone who did not agree to it, and it is why
the app keeps this off by default and per message.

## What it stores

A token, a timestamp, a grade, and the first 200 characters of the user agent. No IP address, no
recipient, no subject, no body. Entries expire after ninety days. A test asserts the shape so a
future change cannot quietly widen it.

## Routes

- `GET /p/<token>.gif` records the fetch and returns the image. Always 200, even when storage fails:
  a tracked message must never look broken to the person who received it.
- `POST /register` `{token, sentAt}` tells the service a message went out. Bearer token required.
- `GET /events?since=<ms>` returns what happened. Bearer token required.

## Deploying

```bash
npx wrangler kv namespace create EVENTS      # put the id in wrangler.toml
npx wrangler secret put PIXEL_AUTH_TOKEN     # a long random string
npx wrangler deploy
```

Then put the worker URL and the same token into the app's settings. Any runtime that speaks the
Fetch API works too; `src/worker.mjs` has no Cloudflare-specific code and `src/cloudflare.mjs` is
the only adapter.
