# Google Cloud setup for Arcforma Mail

Arcforma Mail talks to Gmail and Google Calendar with OAuth clients you create yourself. There is no Arcforma server in between and no shared app id, so nothing works until you have made at least one. Budget 20 minutes for the first account and about five for each one after that.

**The app walks you through this.** On first run it opens a six-step setup flow, and step 2 is this page in the app: buttons that open the exact Google Cloud console pages in order, two boxes for the client id and secret, and a Save that writes the file for you and runs the sign-in. Nothing here needs a terminal or a text editor. If you have already finished setup, Settings has a **Run setup again** button that brings it back. `docs/onboarding.md` describes the whole flow.

The rest of this page is the hand-written fallback: what the app is doing on your behalf, and how to do it yourself if you would rather.

## Why one project per account

Gmail's scopes are "restricted". A project whose consent screen is **Internal** needs no Google verification and its tokens never expire, but Internal is only available to a Google Workspace account inside that organization. A personal gmail.com account can only be External, and an External app left in Testing has its refresh token expired by Google every 7 days.

| Account | Consent screen | Token life |
|---|---|---|
| you@your-company.com (Workspace) | Internal | no expiry |
| you@gmail.com (personal) | External, left in Testing | 7 days, then one press of Sign in |

Phase 2 of `docs/ROADMAP.md` is the plan to get one External app through Google verification so this step disappears for everyone.

## Steps, per account

Sign in to https://console.cloud.google.com as the account that owns the project: the Workspace admin for a company domain, the Gmail address itself for a personal one.

1. **Create the project.** https://console.cloud.google.com/projectcreate. For a Workspace account, check that the Organization field shows your domain. Note the project id under the name; the app takes it and pins the next three links to that project.
2. **Enable the three APIs.** One page does all three: https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com,people.googleapis.com Add `&project=<your project id>` to skip the picker.
3. **Consent screen.** https://console.cloud.google.com/auth/branding
   - App name: `Arcforma Mail`. Support email and developer contact: your address.
   - Audience: **Internal** for a Workspace account. **External** for a personal one; do not press Publish, leave it in Testing, and under Audience > Test users add that address.
   - Scopes: Add or remove scopes, paste these into the manual entry box one per line, then Add to table.
     ```
     https://www.googleapis.com/auth/gmail.modify
     https://www.googleapis.com/auth/gmail.settings.basic
     https://www.googleapis.com/auth/calendar.readonly
     https://www.googleapis.com/auth/contacts.readonly
     https://www.googleapis.com/auth/contacts.other.readonly
     https://www.googleapis.com/auth/userinfo.email
     ```
4. **Create the OAuth client.** https://console.cloud.google.com/auth/clients > Create client. Application type: **Desktop app**. Name it after the machine. It shows you a Client ID and a Client secret.

Paste those two into step 2 of the app's setup flow and press **Save and sign in**. That is the end of it.

## The fallback: writing the clients file by hand

The app reads `~/Library/Application Support/Arcforma Mail/oauth-clients.json`. Setup writes it for you at mode 600. To write it yourself:

```json
{
  "accounts": [
    { "id": "company", "email": "you@your-company.com", "clientId": "000000000000-xxxxxxxx.apps.googleusercontent.com", "clientSecret": "...", "consent": "internal" },
    { "id": "personal", "email": "you@gmail.com", "clientId": "000000000000-yyyyyyyy.apps.googleusercontent.com", "clientSecret": "...", "consent": "external" }
  ]
}
```

Then `chmod 600` it. `id` is any short lowercase name, unique in the file, and it is what the app calls that mailbox internally; changing it later orphans the stored token. `consent` is `internal` or `external` and only decides what the app tells you about token expiry. An entry whose `clientId` and `clientSecret` are blank is a placeholder: the account appears in the app with a note that it has no credentials yet, rather than being ignored.

Refresh tokens are never written here. They are encrypted by macOS through `safeStorage` and kept in the app's own data folder.

Setup and hand-editing can be mixed. Adding an account through the app keeps every entry already in the file, including hand-written ones and placeholders, and refuses a slot id, address, or client id that is already there rather than overwriting it.

## Also worth doing once

- Choose how AI works. Step 3 of setup does this: local only, a Claude Code login, or an Anthropic API key. The equivalent by hand is `claude setup-token` and `packages/ai-daemon/set-token.sh`.
- The local model. Step 4 downloads it. By hand: put a GGUF in `~/Library/Application Support/Arcforma/models/` and point `local.model` in `ai-daemon.json` at it.
- Arcforma Text. Step 5 installs it and checks the Accessibility grant. By hand: `packages/text-tools/install.sh`, then grant Accessibility in System Settings.


## Do not leave a personal project in Testing

The seven-day sign-out is a property of Testing publishing status, not of being unverified. In the Google Auth Platform under Audience, press **Publish app**. Google will warn that the app is unverified and, when a stranger signs in, show them a screen saying so. For your own mailbox that is the accurate description and the warning is the whole cost. Refresh tokens then last until you revoke them.

Google's own documentation permits this: verification is not required when "you are the only user of your app or if your app is used by only a few users, all of whom are known personally to you." The limit is 100 users over the lifetime of the project, which does not bind a personal setup.

A Workspace account should use an Internal consent screen instead, which has neither the warning nor the cap.
