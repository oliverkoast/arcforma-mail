# 1. Record architecture decisions

Date: 2026-09-03

## Status

Accepted

## Context

This project was built quickly and by one person, so the reasoning behind its larger choices lived only in a conversation. Anyone arriving later, including its author in six months, would find the code but not the argument, and would be free to undo a deliberate decision by accident.

Architecture prose rots because the system moves and the prose does not. A dated, immutable record does not: it says what was decided on a day and why, and a later decision supersedes it rather than editing it.

## Decision

Record each significant decision as a numbered file in `docs/adr/`, using Michael Nygard's format: title, status, context, decision, consequences. A decision is significant when it constrains what can be built later, or when someone could reasonably do the opposite.

Never edit an accepted record to reflect a change of mind. Write a new one and mark the old one superseded.

## Consequences

There is a place to look before undoing something on purpose. The cost is roughly fifteen minutes per decision, paid only for decisions that constrain the future. Records that turn out to be wrong stay in the repository, marked superseded, because the wrong turn is part of the reasoning.
