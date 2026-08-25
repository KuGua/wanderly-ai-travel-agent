# Frontend Chat Prototype

## Purpose

The Explore map includes a presentation-only entry point for a future private
Wanderly Agent conversation. It establishes responsive layout and interaction
without claiming that an Agent API response has occurred.

## Current behavior

- Landscape layouts show a liquid-glass message capsule at the lower right. Sending a
  non-empty message opens a fixed white panel along the right side. The panel
  keeps a 2:3 width-to-height ratio: narrower landscape widths use roughly 2/5 of
  the viewport bottom edge and scale both dimensions together, while larger
  fullscreen layouts are capped at 620 px wide and 852 px high. The closed
  capsule uses the same width and height as the composer's liquid-glass input
  at the corresponding viewport size.
- Portrait layouts show the capsule above the bottom navigation. Sending opens a fixed
  panel at 3/5 of the viewport height so it scales with different portrait
  aspect ratios. The closed capsule also matches the inset and proportions of
  the input inside that panel; the Explore recommendation card is
  hidden on mobile. The map camera moves into the uncovered
  area: without a selected pin the globe scales to about 80%; with a selected
  pin the zoom is preserved and that coordinate is centered above the panel.
- Selecting a map pin while chatting suppresses the separate Destination
  Preview, zooms to at least region level, and adds a compact place prompt above
  the composer. The user can expand/collapse the chat from its top edge.
- The mobile composer has no divider and uses a white footer behind the place
  prompt and liquid-glass input.
- Map drag and zoom remain enabled while the conversation is open. The compact
  header omits secondary copy so the map keeps more vertical space.
- Landscape camera padding follows the panel's measured width. The globe shifts
  left and scales to fit the uncovered area; selected pins stay centered in
  that area. The calculation reruns on viewport resize without overriding
  subsequent manual map gestures.
- The former “Explore the world” recommendation card is removed so it cannot
  overlap the conversation composer; named markers remain available on-map.
- Compact map attribution starts as an `i` control. Clicking it expands the map
  sources; clicking it again collapses them.
- Closing the panel returns to the capsule. Messages are held only in React
  memory and disappear on refresh.
- A small `Chat history` action opens the conversation without sending a
  message and is hidden while chat is open.
- While chatting, the first click on a pin adds its compact prompt without a
  Destination Preview. A second click on the same pin closes chat and reveals
  the preview without another camera move. Using the chat close button instead
  clears the selected place and returns directly to the map.
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
