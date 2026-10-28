# Reusable product and implementation planning prompt

Copy the prompt below into a planning chat. It requests ideation and a concrete plan; it does not authorize implementation, messaging other people, bookings or spending.

---

Act as my product partner and senior full stack engineering planner. Help me refine and plan a hackathon project called, provisionally, Group Dinner Planner. Challenge weak assumptions, make practical recommendations, and keep the first version small enough for a solo developer to finish and test.

## My context

- I am a solo full stack engineer with a master's in computer science focused on ML. I can build web applications with LLM assistance, but my recent hands-on ML experience is limited.
- I am participating in the Meta Global AI Developer Hackathon and intend to use Muse meaningfully. My $150 model credit was pending at our last discussion; confirm current access instead of assuming it arrived.
- My objective is a useful, demonstrable product with evidence from real users. Winning is an aspiration, not an outcome to promise.
- The initial activity is dinner for 3–6 friends in one city.
- Telegram is my chosen primary interface. Plan around individual chats with a Telegram bot powered by Muse, with shared dinner state behind them. I initiate the dinner, the bot coordinates with friends who join, and I receive concise milestone updates. Do not reopen the platform comparison or assume access to friends' private chats before they start the bot. Our ordinary social chat is WhatsApp, where I can manually share the invitation link; automated WhatsApp integration is outside scope.
- This task is ideation and planning only. Do not start building the application.

## Product hypothesis

Busy friends struggle to turn “we should get dinner” into an agreed plan. The organizer absorbs the work of collecting availability, reconciling constraints, researching places, following up and revising suggestions.

Build an AI coordinator that collects participant input, proposes feasible dinner plans, handles changes and tracks explicit agreement. The promise is: “Message your planner once. It handles the dinner coordination and keeps you updated.” I initiate the interaction, delegate routine coordination, and receive concise progress updates. Muse asks me to intervene only for meaningful decisions and blockers.

The successful first workflow is intention → invitation → constraints → two proposals → revision if needed → explicit confirmations → calendar event and accurate reservation handoff.

## Scope and behavior

- Focus on one group, one dinner, one city and a bounded date window. Support a complete manual-availability workflow; calendar integration is optional.
- Separate firm constraints, flexible preferences and missing information. Missing replies are not consent, and calendar availability is not agreement.
- Muse should interpret conversational input, ask focused follow-ups, use research tools, explain tradeoffs and handle revisions. Dependable software should enforce represented hard constraints and manage the authoritative plan and confirmation state.
- Keep private participant information private, including in explanations. Use only the calendar detail needed for planning and ask permission for access.
- Require all required participants to confirm the same proposal version. A materially changed plan needs renewed confirmation. Never silently drop a person or relax a firm constraint.
- Ground restaurant claims in sources. Distinguish an estimated cost, published opening hours and actual reservation availability. Label unknowns and demonstration fixtures. Do not infer dietary accommodation from cuisine.
- Require explicit authorization before booking, spending or changing unrelated calendar events. An agreed dinner is not automatically a reserved table.
- Provide a real booking handoff if direct booking access is unavailable. No simulated integration presented as live.
- Exclude trips, flights, hotels, social feeds and autonomous management of everyone's calendar from the first version.
- Friends join through a dinner-specific Telegram bot invitation shared by the organizer and start a private conversation themselves. Validate their dinner membership and track consent and opt-out. A username or phone number supplied by the organizer is not a basis for unsolicited private outreach.
- Follow Telegram's official bot API, permissions and rate limits. Explain Muse processing and which dinner details become shared, obtain the required participant consent, and offer withdrawal/deletion. Private constraints must remain private. Do not collect unrelated group conversations or use planning data for model training.
- Keep group-chat functionality optional for later. The first complete experience uses private chats, interactive confirmations and a shared authoritative plan. Apply Telegram rules rather than importing WhatsApp template or 24-hour-window requirements.
- Batch organizer updates around meaningful milestones, decisions and completion. Do not forward private exchanges or ask the organizer to approve every routine action already delegated. Explicit authorization is still required for commitments outside that scope.

## Your assignment

1. Refine the user, problem, product promise and central hypothesis. Identify where this risks becoming a scheduling poll with an AI interface and propose a concrete difference we can test.
2. Plan the chosen Telegram experience: organizer chat, participant chats, dinner invitation deep links, first-time start and consent, membership/identity, calendar authorization link, confirmation buttons, reminders, quiet hours, opt-out and support. Verify current platform facts using primary documentation. Do not assume the bot can initiate a private conversation with an arbitrary user. Explain how shared plan information is authorized without exposing private participant input, and measure the friction of joining Telegram.
3. Describe the smallest complete user journey, including invitation, private input, missing responses, proposal, change, confirmation and reservation handoff. Specify what the organizer and participants each see.
4. Propose the minimum product scope. Explain which features must work for the demonstration and which can wait. Do not require a stack, booking provider or multi-agent architecture without a reason.
5. Give a high-level technical plan: essential components, shared plan data, participant identity, constraint checking, Muse/tool boundaries and proposal-version confirmation rules. Address timezone handling, concurrent updates and separation of private and shared data without unnecessary infrastructure.
6. Outline the runtime assistant prompts we would need. Define their inputs, permitted actions, expected structured outputs, uncertainty handling and tool-verification rules. Use the attached draft Telegram coordinator prompt if available. Make clear that prompts alone do not enforce permissions, privacy, delivery eligibility or confirmation checks.
7. Identify the riskiest assumptions and cheap experiments to resolve them first: participant adoption, calendar access, venue information, model/tool performance and platform eligibility.
8. Propose a build sequence with effort estimates and a fallback for each external dependency. Confirm the actual deadline, my available hours and official submission requirements before turning it into a dated schedule. Do not invent judging weights or model capabilities.
9. Design a short demonstration with a mid-conversation constraint change, and a small evaluation using real consenting testers. Include organizer effort, time to agreement, constraint accuracy and confirmation correctness. Compare against the group's usual method or a simple poll; do not invent results.
10. Finish with one recommended first version, the key unresolved choices and the next three actions.

Ask up to three high-value clarification questions if answers materially affect the plan. Start with what can be inferred from this context, label assumptions and continue independent planning while optional answers are pending. Keep the language clear and the plan practical. Use the attached product brief if available.
