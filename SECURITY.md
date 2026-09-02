# Security

## Reporting a problem

Report vulnerabilities privately through GitHub's advisory form on this repository, under Security, or by email to security@arcforma.ai. Please do not open a public issue for anything exploitable. Expect a first reply within three working days.

## What this software touches

Arcforma Mail holds a copy of your mail, your Google refresh tokens, and, if you use the AI features, the text of whatever you ask about. All of it stays on your machine.

- **Tokens** are encrypted with Electron `safeStorage`, which uses the macOS Keychain, and are never written to the repository, a log, or a crash report. `oauth-clients.json` lives in Application Support, not here.
- **Mail** lives in a local SQLite database in Application Support. Nothing is uploaded anywhere except back to Google's own APIs.
- **AI** runs two ways. Background classification uses a local model on your machine and never leaves it. On-demand features (summaries, drafts, Ask AI) shell out to the Claude Code CLI under your own login, so the text of that one request goes to Anthropic under your account terms. There is no Arcforma server in the path.
- **Message HTML** renders in a sandboxed iframe with no scripts, no forms, and a content security policy. Remote images are a setting. There is no tracking pixel feature and there never will be.

## If you are running this yourself

You create your own Google Cloud OAuth client, so no third party ever holds a credential that can read your mail. Revoke access at any time from your Google account's security settings, then delete the Application Support folder.
