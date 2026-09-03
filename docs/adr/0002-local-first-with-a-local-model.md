# 2. Mail and sorting stay on the machine

Date: 2026-09-03

## Status

Accepted

## Context

The product sits against Superhuman, which costs thirty dollars a month and passes mail through its own servers. Sorting a mailbox needs a model. A hosted model would be simpler to build and would make the whole mailbox someone else's problem to hold.

## Decision

Mail lives in a local SQLite database. Background classification runs on a local model through the AI daemon and never leaves the machine. Claude is called only on an explicit action (a summary, a draft, a question), through the person's own Claude Code login or their own API key, never from the sync path.

## Consequences

The privacy claim is real and can be checked by reading the code, which is the product's main argument against the incumbent. The costs are genuine: a first run has to download a model, classification quality is bounded by a 4B model rather than a frontier one, and there is no server-side place to improve the classifier from aggregate behaviour. Anything that would send the mailbox to a server needs a new record superseding this one.
