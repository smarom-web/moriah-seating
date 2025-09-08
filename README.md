<<<<<<< HEAD
# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
=======
# Moriah Seating Selector (Starter)

This is a minimal, production-ready seat picker with realtime locking using Supabase.

## 1) Install

```bash
npm install
```

## 2) Configure env

Copy `.env.example` to `.env` and fill the two values from Supabase → Project Settings → API:

```
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

## 3) Create DB tables

Open Supabase → SQL Editor and paste `schema.sql` from this project. Then enable Realtime for table `seat_reservations` in Database → Replication → Realtime.

## 4) Start locally

```bash
npm run dev
```

Open the printed URL.

- Click **Setup Mode**
- Upload your **Final Seat Assignment.xlsx** (first sheet, columns: Row, Seats, Family Last Name, First Name(s))
- The catalog is seeded and pre-reserved seats are locked

## 5) Deploy

- Push this folder to a GitHub repo
- Deploy on Vercel/Netlify
- Set env vars `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`

## Notes

- Unique constraint on `(row_label, seat_number)` prevents double booking.
- Realtime subscription updates other users instantly.
- To free a seat in SQL:

```sql
delete from seat_reservations where row_label='LL' and seat_number=17;
```
>>>>>>> 820a5cf (Initial commit: working seating app)
