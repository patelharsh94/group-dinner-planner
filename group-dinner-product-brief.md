# Group Dinner Planner — working product brief

Status: ideation draft, October 27, 2026. This document describes a proposed product, not an implemented application or validated demand.

## Product concept

An AI coordinator that helps 3–6 friends in one city turn “we should get dinner” into a plan everyone has explicitly agreed to, while reducing the work carried by the organizer.

Telegram is the chosen primary interface. The target experience is separate one-to-one chats with a Telegram bot powered by Muse: the organizer delegates a dinner, the app coordinates with participants who have started the bot and agreed to participate, and the organizer receives concise milestone updates and decisions requiring their input. Group-chat participation is optional and outside the first complete workflow. The first version focuses on dinner; trips and general-purpose calendar management are later possibilities.

The user selected Telegram on October 27, 2026. Do not reopen the interface comparison. Follow Telegram's Bot API and developer terms, including privacy and data-use requirements; platform support does not establish compliance with every applicable law.

## Problem and intended users

The primary user is the friend who usually organizes the group. The other participants want a simple way to state their constraints and respond to concrete proposals.

The hypothesis is that the difficult part extends beyond finding overlapping free time: someone must collect missing answers, reconcile budgets and locations, investigate restaurants, revise suggestions, and get a decision. Validate this with actual dinner organizers before treating it as established demand.

## Product promise

“Message your planner once. It handles the dinner coordination and keeps you updated.”

The first version succeeds when it produces an agreed dinner plan: named attendees, date, local time and timezone, duration, venue, approximate cost with its basis, and a clear reservation status. Agreement does not imply a restaurant reservation exists.

## First complete experience

1. The organizer starts the Telegram bot, describes the dinner, selects required attendees, and chooses a date window, initially the next two weeks. Muse asks only for essential missing details and confirms what routine coordination the organizer is delegating.
2. Muse gives the organizer a dinner-specific invitation link to share through their existing chat. Each friend opens the link, starts the bot in a private chat, confirms which dinner they are joining, and agrees to the described planning and reminder messages. A supplied username or phone number is not sufficient for private outreach. Unknown invitees require the membership check chosen for the product.
3. Muse collects availability, budget, location preferences, food preferences or requirements, and maximum travel time through each participant's own chat. Calendar authorization, if desired, uses a short web link. Participants are told how Muse processes their input and which plan details will be shared; private constraints are kept private.
4. The application distinguishes firm constraints, flexible preferences, and unanswered questions. It asks only follow-ups needed to make progress.
5. A constraint checker identifies candidate times. Restaurant research produces sourced options with known and unknown details separated.
6. Muse proposes at most two plans, explaining the relevant tradeoffs and any outstanding checks. A plan with unknown feasibility is labeled provisional.
7. Participants confirm, decline, or request a change. Muse updates the proposal without losing earlier constraints.
8. Everyone required explicitly confirms the same current proposal. Muse sends an organizer summary and participant plan details only where permitted, and offers a calendar event and reservation handoff. A successful message send is not evidence that someone has read or agreed to the plan.

An optional calendar connection can make availability collection easier, but manual availability must support the complete first workflow.

## Organizer delegation and updates

Once the scope is established, Muse may collect input, research options and revise proposals within the agreed constraints without making the organizer approve each routine message. Delivery still requires each recipient's opt-in and a platform-permitted messaging route.

Send the organizer an acknowledgment, a meaningful milestone update, a request when an actual decision or blocker needs them, and a final agreed-plan update. Batch routine progress; do not forward every exchange or notify on every internal step. A status request should always return the latest accurate state.

Escalate if there is no feasible solution, a required participant declines, a response deadline is reached, the agreed budget or scope must change, a booking requires money or acceptance of terms, or platform access prevents progress. Never silently relax the brief or treat silence as approval.

Contact identity must be unambiguous. The application speaks as the planner, identifies the organizer and dinner context where permitted, and never impersonates the organizer. Participant input is used for that dinner; membership and proposal versions keep replies attached to the right plan.

## Where Muse contributes

- Interpret conversational constraints such as “Tuesday works after seven, but only if I can get home by ten.”
- Identify ambiguity and ask focused questions instead of inventing missing details.
- Use research tools to find restaurant information and summarize the supporting evidence.
- Explain why an option works, why another fails, and which preference could be relaxed if no solution exists.
- Maintain a coherent conversation as participants revise their answers.

Ordinary application logic should enforce date/time, duration, membership, budget and other represented hard constraints. Calendar arithmetic and final authorization should not depend solely on an LLM's prose.

## Smallest credible first version

- One group of 3–6 people and one dinner request at a time.
- One city and a bounded restaurant search area.
- Manual availability and preferences, two proposed plans, revisions and explicit confirmation.
- Separate private participant input from the shared proposal.
- A small set of genuinely researched venues, each with source links and checked times.
- Calendar export or an optional connection to one calendar provider.
- A reservation link or clearly labeled manual handoff, unless real booking access is established early.

Do not include flights, hotels, automatic movement of unrelated calendar events, a social feed, or a multi-platform launch. Do not build a general-purpose assistant or a large collection of agents merely to demonstrate complexity.

## Important behavior

- Calendar availability is not willingness to attend; lack of a reply is not agreement.
- Use local date, time and an explicit timezone. Consider travel time and an agreed buffer where travel data is available.
- A required attendee is never silently removed to make a plan feasible. Changing that requirement needs an explicit organizer decision visible to the group.
- An empty calendar is not proof of availability if the participant has not authorized that interpretation.
- Private budget and scheduling details are not exposed through explanations. Shared text can say an option fits the group's constraints without identifying whose constraint limited the result.
- Material changes to date, time, venue, price basis or attendees create a new proposal version and require renewed confirmation from the affected participants. Never carry confirmations onto a materially different plan without their knowledge.
- Price estimates, opening hours, dietary information and live reservation availability are different claims. Show sources and uncertainty for each. Do not infer accommodation of a dietary requirement from cuisine alone.
- No fabricated restaurant availability, calendar connection, confirmation or booking. Demonstration fixtures must be labeled as sample data.
- Booking, payment and consequential calendar changes require the relevant person's explicit authorization. Background reminders require participant opt-in and a supported messaging channel.

## What might differentiate it

The hypothesis is that the product takes responsibility for resolving a plan: it carries constraints through a conversation, discovers what is missing, handles changes, and tracks agreement. Existing scheduling and social-calendar products mean this must be demonstrated and validated rather than claimed as unique.

The experience should avoid transferring the organizer's work into a long questionnaire. Start with a few essential questions and ask follow-ups only when needed. Participants should be able to respond directly to concrete proposals.

## Demonstration story

Use four consenting testers or clearly labeled sample participants.

1. Organizer asks for dinner next week, with a budget and search area.
2. Participants provide overlapping availability and different preferences.
3. Muse produces two sourced proposals and explains the tradeoff.
4. One participant introduces a new constraint, invalidating the leading proposal.
5. The app identifies the conflict, offers a valid alternative, and gathers fresh confirmations.
6. The agreed plan appears with calendar export and an accurate reservation status.

The central demonstration is reliable recovery from a change, followed by actual agreement. A polished restaurant suggestion alone is insufficient proof of the product's promise.

## Validation before expanding

Interview two or three organizers about their most recent dinner: where the process stalled, who followed up, how the venue was chosen, and what would make them abandon a new tool. The interface is now Telegram; test whether the group will join the bot and whether private chats preserve the convenience the user wants. Measure onboarding friction explicitly because the user's friends ordinarily communicate through WhatsApp.

Then organize a real dinner with a consenting group. Track organizer time spent, time until agreement, number of follow-ups, participant completion, and hard-constraint violations. Ask whether they would use the product again and whether the dinner happened. Compare with a recent similar planning experience or a simple scheduling poll; describe limitations of that comparison. Do not claim improved friendship or reduced loneliness from a single test.

## Open decisions

1. What minimal join and consent experience will get the initial group into the Telegram bot, and how should the organizer authorize membership?
2. Which city and test group can supply real feedback immediately?
3. Which restaurant sources and booking links are accessible, and what claims do they support?
4. Is calendar integration necessary to demonstrate value, or can manual availability carry the first test?
5. What is the simplest way to obtain confirmations without excessive notifications?
6. What hackathon submission requirements and Meta model capabilities must be confirmed before implementation?

## Recommended next step

Identify a consenting initial group and a city. Prepare a Telegram interaction script, invitation/consent flow, and implementation plan for the single complete dinner workflow above. Validate model and venue-data access before expanding the feature set.

## Telegram platform basis — reviewed October 27, 2026

- Telegram's [official bot introduction](https://core.telegram.org/bots) explicitly describes bots serving as intermediaries and coordinating meetups, as well as supporting private and group conversations.
- Bots cannot start private conversations with arbitrary users. Each participant must message/start the bot before private coordination; adding a bot to a group does not establish access to every member's private chat.
- Telegram supports [interactive buttons and deep links](https://core.telegram.org/bots/features). Use these for dinner invitations and clear confirmation choices, with conversational free text for constraints and changes.
- Telegram's [developer terms](https://telegram.org/tos/bot-developers) require an appropriate privacy policy, limited retention, deletion and compliance with applicable laws. They permit use of voluntarily submitted data with clear disclosure and individual, explicit, active and revocable consent. Explain Muse processing and the intended sharing of plan details.
- The first version should use official bot APIs and individual authenticated participant chats. Group message access, if added later, must respect the bot's group permissions and privacy mode. Do not collect unrelated group discussions.
- Rate limits, blocked chats and opt-outs need application handling. Bound reminders, respect quiet hours and do not treat delivery failures as participant replies.

The draft coordinator prompt is a product specification. Application code must independently enforce membership, authorized disclosures, confirmation versions, delivery eligibility and consequential-action authorization. Telegram support is not a legal clearance for every implementation or jurisdiction.
