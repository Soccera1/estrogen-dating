# Design source and implementation notes

The accepted references are `approved-desktop.png` and `approved-mobile.png` in this directory. They were generated during the original planning session. The app keeps their cream canvas, plum serif headings, rose actions, sage privacy note, desktop side rail, split discovery card and mobile bottom navigation.

The final mascot asset is `public/mascot.png`, generated with the built-in image tool from the approved portrait. The brief requested the same peach felt octopus, daisy-embroidered green scarf, small flowers, books and warm sage room, without interface text. It is a site illustration; it is not a fictional production member.

Intentional changes from the concepts:

- Branding reads **Estrogen Dating**.
- The logged-out screen introduces the service and hrtID instead of displaying a fake member.
- Real profile content replaces the concept's example text; there is no extra tagline field.
- Avatars are optional; initials provide a fallback.
- Blocking, unmatching, sign-out, credential management, retry feedback and privacy/API links are functional additions required by the implementation plan.
- Onboarding shows a short data-sharing note instead of a consent checkbox, and the footer and welcome copy were reworded after the reference screenshots were approved.

Visual checks compare the native 1505 × 1045 desktop reference and a 390 × 844 mobile viewport. The mobile chat reference is a higher-resolution portrait; its layout is checked at equivalent phone scale. The review covers copy/branding, sidebar and card geometry, heading/body typography, cream/plum/rose/sage palette, portrait framing, action controls, composer visibility and mobile navigation. Browser tests use the Juniper/Mira examples only in ephemeral local D1 fixtures; production has no seeded profiles.

Screenshots from verification are written to `/tmp/estrogen-discovery-qa.png` and `/tmp/estrogen-chat-mobile-qa.png`. They are not bundled or committed. The built-in browser runtime failed during initialization, so verification uses Playwright Chromium instead.
