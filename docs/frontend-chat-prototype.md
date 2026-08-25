# Frontend Chat Integration

## Purpose

The Explore map connects its private Wanderly Agent panel to the owner-only
Chat Thread and Personal Agent turn APIs while preserving the existing
responsive map interaction.

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
- The first submitted question creates one private server thread. Later turns
  reuse it. The browser stores only the thread ID pointer; raw messages remain
  server-authoritative and are restored from the owner conversation endpoint.
- A small `Chat history` action opens the conversation without sending a
  message and is hidden while chat is open.
- While chatting, the first click on a pin adds its compact prompt without a
  Destination Preview. A second click on the same pin closes chat and reveals
  the preview without another camera move. Using the chat close button instead
  clears the selected place and returns directly to the map.
- Each new turn uses a new UUID request ID. A retry reuses the same request ID,
  allowing the backend idempotency boundary to prevent duplicate messages.
- `MODEL` responses render normally. `SAFE_REFUSAL` renders as an assistant
  response with a localized verification-required indicator. Provider/model
  `502` and `504` failures remain errors with an explicit retry action; the UI
  never fabricates a fallback answer.
- Canonical map destinations send exact fixture identifiers, names, and
  `[longitude, latitude]` coordinates. All user-created or geography-derived
  places are sent as unverified `INSPIRATION`; display-only country text is not
  included in the API DTO.
- The browser never sends a message role or sender identity. Thread ownership,
  fixture provenance, Agent policy and persistence remain server-controlled.

## Verification

Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` from
`apps/web`. Manually verify the open/close flow at desktop and mobile widths.

## Authentication boundary

`ApiClient` can attach a token through its existing token-provider callback,
but the web application does not yet expose a real Cognito/session token
source. No access token or demo authorization header is hardcoded. Real browser
conversation calls therefore require the authentication workstream to supply
that callback.
