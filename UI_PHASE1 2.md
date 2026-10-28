# UI/UX Phase 1 - foundation and screen fit

Copy these files over the same paths in pos-app (no database changes, no new npm packages).

## What changed
- Dark and light themes. Button in the top bar. Terminals start dark, office/laptop follow the computer's setting. Choice is remembered per device.
- Device profile from VITE_TERMINAL_CODE: T1/T2/T3 = touch terminal (big targets, zoom locked, no text selection), OFFICE = desktop (denser, zoom allowed, keyboard focus ring). A touch-screen laptop still gets bigger buttons.
- Sizes are fluid from 1024x768 to 1920x1080 (root font and tokens in src/index.css), no more fixed 4-column / 180px / 380px / 640px layouts.
- Order screen: the page no longer grows past the screen, so SEND ORDER and the total are always visible. Old code assumed a 64px top bar; it is 80px.
- Tables, products and queue grids add or drop columns to suit the screen.
- Native confirm/prompt boxes replaced by in-app dialogs (src/feedback.tsx). The reset-PIN box now uses the on-screen keypad. Toast helper added for later phases.
- Receipt printing is always black on white, whichever theme is on.

## Not in Phase 1 (planned)
- Terminal screens that still use a typed text box (Expenses, Stock room, Purchasing) need an on-screen keyboard: Phase 2.
- Home as icon tiles, office sidebar, accountant tables, charts: Phases 2-5.
