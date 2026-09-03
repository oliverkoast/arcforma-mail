# 4. Each person brings their own Google OAuth client, published unverified

Date: 2026-09-03

## Status

Accepted

## Context

Reading Gmail needs an OAuth client, and the roadmap assumed the answer was to verify one shared client so nobody else has to make one. A survey of every open-source mail client that solved this says otherwise. There are two patterns and no third.

Clients with mainstream users ship a public client id and a "secret" in their source and go through Google's verification: Thunderbird, K-9, Mailspring, GNOME Online Accounts, KDE. The secret is not secret and they say so; Mailspring's source comment reads "we're on the honor code, please don't do this." The cost is not the paperwork, it is the outages. KDE's client was blocked by Google for fourteen months, from March 2019 to May 2020. K-9's was blocked for three and a half months in 2024 and 2025 while Thunderbird's separate client kept working, and a maintainer wrote in public that Google's console "is sending us mixed messages on if we're waiting for them or they are waiting for us."

Tools that did not want that burden make each person create their own client: mutt, aerc, offlineimap, Himalaya, lieer. Google's own documentation sanctions it. Verification is not required when "you are the only user of your app or if your app is used by only a few users, all of whom are known personally to you."

The detail that decides the shape is where the seven-day refresh token expiry comes from. It is a property of Testing publishing status, not of being unverified. An External client published to production without verification issues refresh tokens that do not expire, and is capped at 100 users over the project's lifetime.

## Decision

Every person who runs this app creates their own Google Cloud project and OAuth client, and publishes it to production without verification. Onboarding walks them through it and takes the id and secret by paste. The app never ships a client id.

If the project ever wants one-click setup for strangers, that is a separate decision requiring its own record, taken with the KDE and K-9 outages in view, and it does not remove the need for this path as the fallback.

## Consequences

Nobody has to trust this project with access to their mail, and there is no shared client that Google can block and take every user offline with. Setup costs about fifteen minutes and produces a warning screen from Google that says the app is unverified, which is accurate. Workspace accounts can use an Internal consent screen instead and skip both the warning and the cap.

Anyone whose project is left in Testing rather than published will be signed out every seven days. Onboarding must say so plainly, because the symptom appears a week after setup, when the cause is long forgotten.
