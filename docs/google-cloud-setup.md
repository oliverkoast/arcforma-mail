# Google Cloud setup for Arcforma Mail

Arcforma Mail talks to Gmail and Google Calendar with OAuth clients you create yourself. Nothing on this Mac has them yet. Budget 20 minutes. You will end with three OAuth desktop clients, one per account, and a local JSON file the app reads.

## Why three projects

Gmail scopes are "restricted". A project whose consent screen is **Internal** needs no Google verification and its tokens never expire, but Internal is only available to Google Workspace accounts inside that org. So:

| Account | Project | Consent screen | Token life |
|---|---|---|---|
| you@example.com | `arcforma-mail` in the arcforma.ai org | Internal | no expiry |
| you@example.net | `arcforma-mail` in the formai.build org | Internal | no expiry |
| you@gmail.com | `arcforma-mail-personal` in your personal Google account | External, left in Testing | 7 days, then one keypress in the app to sign in again |

## Steps, per project

Sign in to https://console.cloud.google.com as the account that owns the project (the Workspace admin for the two company orgs, your personal Gmail for the third).

1. **Create the project.** Top bar project picker > New project. Name it as in the table. For the Workspace ones, make sure the Organization field shows the company domain.
2. **Enable APIs.** APIs and Services > Library. Enable each of: `Gmail API`, `Google Calendar API`, `People API`.
3. **Consent screen.** APIs and Services > OAuth consent screen (Google now calls this "Google Auth Platform" > Branding / Audience).
   - App name: `Arcforma Mail`. Support email: your address. Developer contact: your address.
   - Audience: **Internal** for the two Workspace projects. **External** for the personal one; do not click Publish, leave it in Testing, and under Audience > Test users add `you@gmail.com`.
   - Scopes: Add or remove scopes, then paste these into the manual entry box, one per line, and Add to table:
     ```
     https://www.googleapis.com/auth/gmail.modify
     https://www.googleapis.com/auth/gmail.settings.basic
     https://www.googleapis.com/auth/calendar.readonly
     https://www.googleapis.com/auth/contacts.readonly
     https://www.googleapis.com/auth/contacts.other.readonly
     https://www.googleapis.com/auth/userinfo.email
     ```
4. **Create the OAuth client.** APIs and Services > Credentials > Create credentials > OAuth client ID. Application type: **Desktop app**. Name: `Arcforma Mail on Oliver's Mac`. Download the JSON or copy the Client ID and Client secret.

## Put the clients where the app reads them

Create `~/Library/Application Support/Arcforma Mail/oauth-clients.json`:

```json
{
  "accounts": [
    { "id": "arcforma", "email": "you@example.com", "clientId": "…apps.googleusercontent.com", "clientSecret": "…", "consent": "internal" },
    { "id": "formai", "email": "you@example.net", "clientId": "…", "clientSecret": "…", "consent": "internal" },
    { "id": "personal", "email": "you@gmail.com", "clientId": "…", "clientSecret": "…", "consent": "external-testing" }
  ]
}
```

Then run `chmod 600` on it. The app opens the browser sign-in per account from its onboarding screen; refresh tokens are stored encrypted by the app, never in this file.

## Also required once

- `claude auth login` in a terminal, so the AI daemon can use your Claude Code login. Check with `claude auth status` from a fresh terminal: it must say `"loggedIn": true`.
- Grant Accessibility to Arcforma Text the first time it asks.
