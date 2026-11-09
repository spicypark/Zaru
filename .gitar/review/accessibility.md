# Accessibility: See mode is used by blind people, Hear mode by deaf people

Apply alongside the standard review to `web/src/`.

**See mode** (`web/src/see/`, `web/src/screens/SeeScreen.tsx`) must be fully usable with VoiceOver and without sight. Flag as **blocking**:

- Interactive elements that are not native `<button>`/`<a>`/form controls, or that lack an accessible name.
- Touch targets smaller than 44×44 CSS px, or more than the agreed controls on the main screen. The agreed See layout (owner decision): a full-screen "Start Zaru See" button; then the live camera with a large Start/Pause narration toggle, a compact "Ask a question" button (at least 44 px tall, sized by the owner), plus "Settings" (speech rate) and "Switch mode". Narration is continuous, so Ask being compact is intended, not a regression.
- Information conveyed only visually (colour, icons, layout) with no spoken equivalent.
- Announcements routed through `aria-live` regions in See mode. Zaru speaks with `speechSynthesis`; live regions make VoiceOver talk over it.
- Audio or speech started outside a user gesture on first use (iOS blocks it silently).

**Hear mode** (`web/src/hear/`, `web/src/screens/HearScreen.tsx`):

- Caption and bubble text must stay at least 1.2rem with high contrast against the camera feed. Flag changes that shrink it or reduce contrast.
- Speech that can't be attributed to a face must still be shown (caption bar), never dropped.

Both modes must work on iPhone Safari (home-screen web app) and desktop Chrome/Edge/Safari with a laptop webcam. Flag APIs not supported by iOS Safari unless there is a fallback (e.g. `navigator.vibrate`).
