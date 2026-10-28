# Grills Lounge Ndagani POS — Project status

Last updated: 27 Oct 2026

## Where we are
- Phase 0 (design): done
- Phase 1 (foundation): done and working (database, permissions, staff, PIN login)
- Phase 2 (terminals and ordering): done and tested by you ("perfect")
- Next: Phase 3 (payments and bills)

## Decisions made
| Decision | Value |
|---|---|
| Stack | React + TypeScript + Vite + Tailwind, Supabase (Postgres, Auth, Edge Functions, Realtime) |
| Trading-day rollover | 05:00 Africa/Nairobi |
| Payments when offline | Blocked (online only) |
| Billable trigger | Lines bill when SERVED (food and drinks) |
| Liquor custody deducted | When served |
| Bartender collects payments | Off by default (per-person override) |
| VAT / service charge | Unset until rates are confirmed |
| Terminals | T1 Kitchen+Choma, T2 Bar A, T3 Bar B; manager/accountant use the office browser |
| Staff sign-in | Terminals: staff ID + 6-digit PIN. Office: email + password (MFA to add later) |
| Staff IDs | Upper-case, case-insensitive (W001, B001, K001, C001, A001) |
| Station "none" products | Recorded as served immediately (nothing to prepare) |
| Auto-lock | 30 s idle on order screens, 5 min on kitchen/choma/bar queues, and after Send |

## Supabase project
- URL: https://panjzmitobrqmqzdpkvb.supabase.co
- Manager account: staff ID M001 (office login with email + password)
- Secrets (service-role key, database password) are never put in the app or in chat.

## SQL files (run in this order in the Supabase SQL Editor)
| File | Status | Purpose |
|---|---|---|
| 001_foundation.sql | Run | Tables, ledgers, views, payment RPC, baseline RLS |
| 002_phase1.sql | Run | Permissions and roles seed, PIN functions, terminals, demo tables, catalogue import RPC |
| 003_rls_reads.sql | Run | RLS everywhere, read policies, safe views |
| 004_profile_rpcs.sql | Run | my_profile, list_staff, set_staff_active |
| 005_phase2_ordering.sql | Run | open_tab, submit_order, claim_item, update_item_status, station_queue, tab_cards, Realtime |
| 006_demo_catalogue.sql | Run | 11 fake products across bar, choma, kitchen (all flagged is_demo) |

## App (pos-app/)
- Office login and terminal PIN login (on-screen letters + digits and number keypad)
- Home screen showing only the buttons each role may use
- Staff admin: add staff, reset PIN, activate/deactivate
- Waiter ordering: tables grid, named/takeaway tabs, product grid, cart, SEND ORDER with
  double-tap protection, "Order #N received" confirmation, lock after send
- Offline safety: drafts saved per staff, "NOT SENT" banner and top-bar count, automatic
  retry with the same idempotency key (no duplicates)
- Kitchen / Choma / Bar queues: Accept (atomic claim), Start, Ready, Served; "Being prepared at
  Bar B" on the other screen; amber then red LATE cards; live updates with polling fallback
- "On this tab" list for waiters with a Served button when an item is READY

Edge Functions deployed: `pin-login`, `staff-admin`.
Terminal is chosen by `VITE_TERMINAL_CODE` in `.env` (OFFICE, T1, T2, T3).

## Known limits and open items
- Tab totals count only SERVED items; the bill screen arrives in Phase 3.
- NOT SENT retries only run while that waiter is signed in.
- Cancelling an accepted item needs the approval flow (Phase 3/4).
- Item notes, favourites ordering and the bar direct-sale screen are not built yet.
- Catalogue import screen (CSV/Excel) and manual product form are not built (the import RPC exists).
- Two npm audit warnings to review in Phase 7.
- Three shared terminals will bottleneck on a busy night; a fourth device is advised.
- Real catalogue, prices, opening stock and staff list are needed before the Phase 4 pilot.
- Testing two people at once needs separate browser profiles or an incognito window.

## Phase 3 plan (payments and bills)
1. Payment screen: huge Total / Paid / Balance, Cash / M-Pesa / Split tabs
2. Cash with tendered amount and change due (change is never revenue)
3. M-Pesa code entry; duplicate codes rejected; shows "Awaiting verification"
4. Partial and mixed payments; payments blocked when the connection drops
5. Request bill; interim bill labelled "NOT A RECEIPT"; split bill (by item / equally)
6. Final receipt, 58mm print layout; printing can never create a second payment
7. Tab closing rules: settles only at zero balance, or an approved credit/exception
8. Pilot night on demo data: order, serve, pay, close

## Later phases
4 Bar stock and custody · 5 Accountant reconciliation · 6 Kitchen recipes, purchases, reports ·
7 Production readiness
