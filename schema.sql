-- Run this in Supabase SQL editor

-- All seats that exist
create table if not exists public.seat_catalog (
  row_label text not null,
  seat_number int not null,
  section text,
  primary key (row_label, seat_number)
);

-- Reservations
create table if not exists public.seat_reservations (
  row_label text not null references seat_catalog(row_label) on update cascade on delete cascade,
  seat_number int not null,
  reserved_by text,
  reserved_at timestamptz not null default now(),
  unique (row_label, seat_number)
);

-- Security
alter table public.seat_catalog enable row level security;
alter table public.seat_reservations enable row level security;

create policy if not exists catalog_read
on public.seat_catalog for select using (true);

create policy if not exists reservations_read
on public.seat_reservations for select using (true);

create policy if not exists reserve_seat
on public.seat_reservations for insert
with check (
  exists (select 1 from seat_catalog c where c.row_label = row_label and c.seat_number = seat_number)
);

-- Realtime: in Supabase dashboard -> Database -> Replication -> Realtime
-- add table public.seat_reservations to broadcasts.
