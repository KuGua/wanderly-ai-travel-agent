# Frontend Chat Prototype

## Purpose

The Explore map includes a presentation-only entry point for a future private
Wanderly Agent conversation. It establishes responsive layout and interaction
without claiming that an Agent API response has occurred.

## Current behavior

- Desktop shows a liquid-glass message capsule at the lower right. Sending a
  non-empty message opens a fixed white panel along the right side.
- Mobile shows the capsule above the bottom navigation. Sending opens a fixed
  panel at 43% of the viewport height; the Explore recommendation card is
  hidden on mobile. The map camera moves into the uncovered
  area: without a selected pin the globe scales to about 80%; with a selected
  pin the zoom is preserved and that coordinate is centered above the panel.
- Selecting a map pin while chatting suppresses the separate Destination
  Preview, zooms to at least region level, and adds a compact place prompt above
  the composer. The user can expand/collapse the chat from its top edge.
- The mobile composer has no divider and uses a white footer behind the place
  prompt and liquid-glass input.
- A mobile compass control stays on the left edge and moves immediately above
  the panel while the conversation is open. Map drag and zoom remain enabled.
- Compact map attribution starts as an `i` control. Clicking it expands the map
  sources; clicking it again collapses them.
- Closing the panel returns to the capsule. Messages are held only in React
  memory and disappear on refresh.
- The prototype does not call Chat Thread or Agent endpoints, persist raw
  conversation text, generate travel advice, or share content with trip
  members.

## Verification

Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` from
`apps/web`. Manually verify the open/close flow at desktop and mobile widths.

## Integration boundary

Before connecting the UI, the frontend must adopt the authenticated owner-only
Chat Thread contracts from the API and agree on the separate Agent response
contract. Client memory must not become the source of truth for persisted
threads or messages.
