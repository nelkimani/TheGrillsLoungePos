# Setting up each device (one Vercel site for all of them)

Open the site ONCE on each device with its code on the end of the address. The browser remembers it.

| Device | Open this once |
|---|---|
| Kitchen + Choma terminal | https://YOUR-SITE.vercel.app/?t=T1 |
| Bar A terminal | https://YOUR-SITE.vercel.app/?t=T2 |
| Bar B terminal | https://YOUR-SITE.vercel.app/?t=T3 |
| Office computer / accountant laptop | https://YOUR-SITE.vercel.app/?t=OFFICE (or just the plain address) |

- After the first visit the "?t=" part disappears from the address; use a normal bookmark / home-screen shortcut.
- Use the same browser on the terminal every day. Clearing that browser's site data forgets the device, and it will show the office email sign-in until the link is opened again.
- To move a device (e.g. T2 becomes T3), open the site with the new code.
- VITE_TERMINAL_CODE in Vercel is now optional; if set, it is only the default for a browser that has never been set up.
- All devices must use the same VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY: that is what makes stock, orders and payments shared.
