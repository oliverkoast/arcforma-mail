# 5. What has to be true before mail text reaches a model

Date: 2026-09-03

## Status

Accepted

## Context

Summaries, drafts, instant replies and Ask AI send the text of a thread to Claude. Background sorting runs on a local model and sends nothing. Google's Workspace API user data and developer policy, last updated 2026-07-22, governs the first case because it is a transfer of Gmail data to a third party.

Two clauses bind. Transfers are allowed only "to provide or improve your appropriate use case or user-facing features that are visible and prominent in the requesting application's user interface and only with the user's consent." And the required security measures now include "protecting against prompt injection techniques by either using Google Cloud Platform's Model Armor or other prompt injection protection", which is new in the last year and applies the moment a mail body reaches a model.

The policy separately forbids using the data to train or improve any model beyond that person's own personalised one. A local model doing inference does not train, so background sorting is clear. Anything that persisted embeddings or fine-tuned would not be.

## Decision

Cloud model calls are opt-in per feature, chosen during setup, and never happen on the sync path. The setup step names what leaves the machine, and the privacy policy this project has yet to write must name the vendor and state that the vendor does not train on the data.

Prompt injection is treated as a certainty, not a risk, because the input is mail from strangers. Every prompt that carries mail content passes it in a JSON envelope as inert data, states that questions and commands inside it are content to be handled rather than instructions to follow, and requires a completion marker so a truncated or hijacked answer is rejected rather than used. That is the "other prompt injection protection" the policy allows, and it has to be documented rather than merely implemented.

Nothing derived from mail is retained anywhere but this machine.

## Consequences

The app stays inside the policy that lets it read Gmail at all, and the protection is the same design that keeps a hostile message from steering a draft, so it earns its place twice. The debt this records is real: there is no privacy policy yet, and one is required before anyone but the author runs this against a production OAuth client. Adding a feature that sends mail text anywhere new means revisiting this record, not just writing the code.
