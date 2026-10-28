# Group Dinner Planner

A Telegram dinner coordinator powered by Muse. An organizer delegates dinner planning, the bot gathers input from friends in private chats, and the organizer receives meaningful progress updates and decisions requiring their attention.

## Status

Product ideation and planning. The repository contains the product brief and reusable prompts; an application has not yet been implemented.

## First version

- Dinner for 3–6 friends in one city.
- Dinner-specific invitations and participant onboarding through a Telegram bot.
- Private availability and preferences, two proposed plans, and revisions when constraints change.
- Explicit confirmation of the same plan version by all required participants.
- Organizer milestone updates, calendar export, and an accurate reservation handoff.

## Planning documents

- [Product brief](group-dinner-product-brief.md): scope, user journey, behavior, demo and validation.
- [Planning prompt](group-dinner-planning-prompt.md): reusable prompt for product and implementation planning.
- [Telegram coordinator prompt](telegram-dinner-coordinator-prompt.md): draft runtime behavior and application enforcement boundaries.
- [Superseded WhatsApp prompt reference](whatsapp-dinner-coordinator-prompt.md): redirect retained for historical links.

## Next steps

1. Identify the initial dinner group and city.
2. Design and walk through the Telegram conversations, including a changed constraint.
3. Confirm Muse and venue-data access, then prepare the implementation plan.

Never commit API tokens, calendar credentials, private conversations or real participant data.
