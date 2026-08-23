# Reference signed-in homepage prototype

`assets/reference-homepage.html` is a self-contained, static reference for the **signed-in user home screen** of Travel Together. It is **not** a marketing/introductory page, application runtime, API contract, or deployment path.

## Purpose

It translates the current product documents into the first workspace a returning traveler sees. The information hierarchy is intentionally action-first:

1. the user sees whether a current shared trip needs their attention;
2. they can continue their private Personal Agent conversation;
3. they can inspect personal tasks and their scoped sharing status; and
4. they can distinguish stable private preferences from trip-scoped shared preferences.

It also communicates the MVP's central promises:

- each traveler retains a private, editable profile;
- only explicit, trip-scoped consent enters the shared workspace;
- coordinated options explain price, service, and preference trade-offs;
- changes make the prior plan stale and expose a re-plan diff; and
- booking orchestration never charges or books automatically.

The displayed state is Alice's fixture-style example: a Lisbon plan has been replanned after a price change and needs review. All people, destinations, prices, times, and statuses in the page are illustrative content, not live availability, inventory, legal guidance, or booking data.

## Run and verify

Open `assets/reference-homepage.html` directly in a modern browser. It needs no server, package, environment variable, or backend service.

Verify the 375px, 768px, 1024px, and 1440px layouts, then navigate with the keyboard. Links and buttons retain visible focus, the document provides a skip link, and reduced-motion users receive no nonessential motion.

## Boundaries

The prototype does not call the backend, store personal data, authenticate a user, request consent, run planning, or initiate booking. A future production interface must source all displayed plan, consent, status, and confirmation data from the server-authoritative model described in the PRD and `TECH_STACK.md`.
