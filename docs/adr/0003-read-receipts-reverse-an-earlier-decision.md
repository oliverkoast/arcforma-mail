# 3. Read receipts exist, off by default, and are honest about what they know

Date: 2026-09-03

## Status

Accepted. Supersedes the rule stated in CONTRIBUTING and SECURITY that this project would never have tracking pixels.

## Context

The owner asked for read receipts after previously declining them. Those earlier documents said publicly that the project would never carry a tracking pixel, which after this change would have been untrue.

A tracking pixel reports that software requested an image. It does not report that a person read anything. Gmail proxies images and many recipients block them, so no signal is not the same as unread. Apple Mail Privacy Protection fetches the image on arrival whether or not anyone looks, which produces confident false positives in most tools that do this.

## Decision

Read receipts exist, are off by default, and are chosen per message. The endpoint lives in `packages/pixel-service` and is deployed by whoever runs the app, not by this project. Every fetch is graded: `opened`, `automatic` (a prefetch, a scanner, or Apple's proxy), or `unknown`. A message with no fetch reports "no signal", never "unread". The service stores a token, a timestamp, a grade, and a truncated user agent, and never an IP address or anything identifying the recipient.

CONTRIBUTING, SECURITY, and the README were corrected to describe this rather than the promise they used to make.

## Consequences

This is the one case where sending mail from this app causes a request from a recipient to a server, so the local-first claim in record 2 now carries an exception that has to be stated wherever the claim is made. In exchange the feature does not lie, which is the part most implementations get wrong. Anyone who would rather not do this to their recipients leaves it off and none of it runs.
