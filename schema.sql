create extension if not exists pgcrypto;

create table if not exists public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    username text not null,
    created_at timestamptz not null default now()
);

create table if not exists public.dev_socket_tokens (
    token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
    user_id uuid not null references auth.users(id) on delete cascade,
    created_at timestamptz not null default now(),
    revoked_at timestamptz
);

create unique index if not exists dev_socket_tokens_one_active_per_user_idx
    on public.dev_socket_tokens (user_id)
    where revoked_at is null;

create table if not exists public.demo_wallets (
    user_id uuid primary key references public.profiles(id) on delete cascade,
    balance_cents bigint not null default 10000 check (balance_cents >= 0),
    total_wagered_cents bigint not null default 0 check (total_wagered_cents >= 0),
    total_returned_cents bigint not null default 0 check (total_returned_cents >= 0),
    free_spins_remaining integer not null default 0 check (free_spins_remaining >= 0),
    updated_at timestamptz not null default now()
);

create table if not exists public.demo_wallet_transactions (
    id bigint generated always as identity primary key,
    user_id uuid not null references public.profiles(id) on delete cascade,
    kind text not null check (kind in ('demo_credit', 'wager', 'payout')),
    amount_delta_cents bigint not null,
    balance_after_cents bigint not null check (balance_after_cents >= 0),
    reference_id uuid not null,
    details jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    unique (user_id, kind, reference_id)
);

create table if not exists public.demo_spins (
    id bigint generated always as identity primary key,
    user_id uuid not null references public.profiles(id) on delete cascade,
    request_id uuid not null,
    bet_index integer not null check (bet_index between 0 and 14),
    wager_cents bigint not null check (wager_cents >= 0),
    payout_cents bigint not null check (payout_cents >= 0),
    result_symbols jsonb not null,
    is_free_spin boolean not null default false,
    balance_after_cents bigint not null check (balance_after_cents >= 0),
    total_wagered_after_cents bigint not null default 0,
    total_returned_after_cents bigint not null default 0,
    free_spins_after integer not null default 0,
    free_spins_awarded integer not null default 0,
    created_at timestamptz not null default now(),
    unique (user_id, request_id)
);

alter table public.demo_spins
    add column if not exists total_wagered_after_cents bigint not null default 0,
    add column if not exists total_returned_after_cents bigint not null default 0,
    add column if not exists free_spins_after integer not null default 0,
    add column if not exists free_spins_awarded integer not null default 0;
alter table public.demo_spins
    drop constraint if exists demo_spins_bet_index_check;
alter table public.demo_spins
    add constraint demo_spins_bet_index_check check (bet_index between 0 and 14);

create index if not exists demo_wallet_transactions_user_created_idx
    on public.demo_wallet_transactions (user_id, created_at desc);
create index if not exists demo_spins_user_created_idx
    on public.demo_spins (user_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.demo_wallets enable row level security;
alter table public.demo_wallet_transactions enable row level security;
alter table public.demo_spins enable row level security;
alter table public.dev_socket_tokens enable row level security;

drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile" on public.profiles
    for select to authenticated using (auth.uid() = id);

drop policy if exists "Users can read own demo wallet" on public.demo_wallets;
create policy "Users can read own demo wallet" on public.demo_wallets
    for select to authenticated using (auth.uid() = user_id);

drop policy if exists "Users can read own demo transactions" on public.demo_wallet_transactions;
create policy "Users can read own demo transactions" on public.demo_wallet_transactions
    for select to authenticated using (auth.uid() = user_id);

drop policy if exists "Users can read own demo spins" on public.demo_spins;
create policy "Users can read own demo spins" on public.demo_spins
    for select to authenticated using (auth.uid() = user_id);

create or replace function public.create_demo_player()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    new_reference uuid := gen_random_uuid();
begin
    insert into public.profiles (id, username)
    values (
        new.id,
        coalesce(nullif(new.raw_user_meta_data ->> 'username', ''), new.email, 'player')
    );

    insert into public.demo_wallets (user_id, balance_cents)
    values (new.id, 10000);

    insert into public.demo_wallet_transactions
        (user_id, kind, amount_delta_cents, balance_after_cents, reference_id, details)
    values (new.id, 'demo_credit', 10000, 10000, new_reference, '{"reason":"initial_demo_credits"}'::jsonb);
    return new;
end;
$$;

drop trigger if exists on_auth_user_created_demo_player on auth.users;
create trigger on_auth_user_created_demo_player
    after insert on auth.users
    for each row execute function public.create_demo_player();

insert into public.profiles (id, username)
select id, coalesce(nullif(raw_user_meta_data ->> 'username', ''), email, 'player')
from auth.users
on conflict (id) do nothing;

update public.profiles as profile
set username = auth_user.email
from auth.users as auth_user
where profile.id = auth_user.id
  and nullif(auth_user.raw_user_meta_data ->> 'username', '') is null
  and (
      profile.username is null
      or profile.username = ''
      or profile.username = split_part(auth_user.email, '@', 1)
  );

with provisioned_wallets as (
    insert into public.demo_wallets (user_id, balance_cents)
    select id, 10000 from public.profiles
    on conflict (user_id) do nothing
    returning user_id, balance_cents
)
insert into public.demo_wallet_transactions
    (user_id, kind, amount_delta_cents, balance_after_cents, reference_id, details)
select user_id, 'demo_credit', balance_cents, balance_cents, gen_random_uuid(),
       '{"reason":"initial_demo_credits"}'::jsonb
from provisioned_wallets;

drop function if exists public.play_demo_spin(uuid, uuid, integer, boolean, jsonb, boolean);

create or replace function public.play_demo_spin(
    p_user_id uuid,
    p_request_id uuid,
    p_bet_index integer,
    p_result_symbols jsonb,
    p_is_free_spin boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_existing public.demo_spins%rowtype;
    v_wallet public.demo_wallets%rowtype;
    v_bets constant bigint[] := array[
        20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 220, 240, 260, 280, 300
    ];
    v_payout_multiplier constant integer[] := array[3, 2, 1, 1, 1];
    v_power_multiplier constant integer[] := array[0, 0, 0, 0, 0, 10, 5, 2, 0, 0, 0];
    v_wager bigint;
    v_payout bigint;
    v_balance bigint;
    v_free_spins integer;
    v_free_spins_awarded integer := 0;
    v_main_symbol integer;
    v_special_symbol integer;
    v_is_match boolean;
    v_has_nonzero_triple boolean;
    v_total_wagered bigint;
    v_total_returned bigint;
begin
    if p_bet_index < 0 or p_bet_index >= array_length(v_bets, 1) then
        raise exception 'invalid bet index' using errcode = '22023';
    end if;
    if p_result_symbols is null
       or jsonb_typeof(p_result_symbols) is distinct from 'array' then
        raise exception 'result symbols must be a JSON array' using errcode = '22023';
    end if;
    if jsonb_array_length(p_result_symbols) <> 3 then
        raise exception 'result matrix must contain exactly three rows' using errcode = '22023';
    end if;
    if exists (
        select 1
        from jsonb_array_elements(p_result_symbols) as result_rows(row_data)
        where jsonb_typeof(row_data) is distinct from 'array'
    ) then
        raise exception 'each result row must be a JSON array' using errcode = '22023';
    end if;
    if exists (
        select 1
        from jsonb_array_elements(p_result_symbols) as result_rows(row_data)
        where jsonb_array_length(row_data) <> 4
    ) then
        raise exception 'invalid result matrix' using errcode = '22023';
    end if;
    if exists (
        select 1
        from jsonb_array_elements(p_result_symbols) as result_rows(row_data)
        cross join lateral jsonb_array_elements(result_rows.row_data) with ordinality as cells(cell_data, column_number)
        where case when jsonb_typeof(cells.cell_data) = 'number' then
            (cells.cell_data::text)::numeric <> trunc((cells.cell_data::text)::numeric)
            or (cells.cell_data::text)::numeric not between 0 and 11
            or (cells.column_number < 4 and (cells.cell_data::text)::numeric > 5)
        else true end
    ) then
        raise exception 'invalid symbol ID or power symbol column' using errcode = '22023';
    end if;
    v_main_symbol := (p_result_symbols -> 1 ->> 0)::integer;
    v_special_symbol := (p_result_symbols -> 1 ->> 3)::integer;
    v_has_nonzero_triple := v_main_symbol > 0
        and (p_result_symbols -> 1 ->> 1)::integer > 0
        and (p_result_symbols -> 1 ->> 2)::integer > 0;
    v_is_match := v_main_symbol between 1 and 5
        and (p_result_symbols -> 1 ->> 1)::integer = v_main_symbol
        and (p_result_symbols -> 1 ->> 2)::integer = v_main_symbol;
    if p_user_id is null or p_request_id is null then
        raise exception 'user and request id are required' using errcode = '22023';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_user_id::text || p_request_id::text, 0)
    );

    select * into v_existing
    from public.demo_spins
    where user_id = p_user_id and request_id = p_request_id;
    if found then
        return jsonb_build_object(
            'balanceCents', v_existing.balance_after_cents,
            'wagerCents', v_existing.wager_cents,
            'payoutCents', v_existing.payout_cents,
            'resultSymbols', v_existing.result_symbols,
            'isFreeSpin', v_existing.free_spins_awarded > 0,
            'freeSpinCount', v_existing.free_spins_awarded,
            'freeSpinsRemaining', v_existing.free_spins_after,
            'totalWageredCents', v_existing.total_wagered_after_cents,
            'totalReturnedCents', v_existing.total_returned_after_cents,
            'requestId', v_existing.request_id
        );
    end if;

    select * into v_wallet
    from public.demo_wallets
    where user_id = p_user_id
    for update;
    if not found then
        raise exception 'demo wallet not found' using errcode = 'P0002';
    end if;

    if p_is_free_spin and v_wallet.free_spins_remaining < 1 then
        raise exception 'no free spins available' using errcode = '22003';
    end if;
    v_wager := case when p_is_free_spin then 0 else v_bets[p_bet_index + 1] * 3 end;
    v_payout := 0;
    if v_has_nonzero_triple then
        if v_is_match then
            v_payout := v_bets[p_bet_index + 1] * v_payout_multiplier[v_main_symbol];
        else
            v_payout := v_bets[p_bet_index + 1] / 4;
        end if;
        if v_special_symbol between 6 and 8 then
            v_payout := v_payout * v_power_multiplier[v_special_symbol];
        elsif v_special_symbol = 9 then
            v_payout := v_payout + v_bets[p_bet_index + 1] * 2;
        elsif v_special_symbol = 10 then
            v_payout := v_payout + v_bets[p_bet_index + 1];
        elsif v_special_symbol = 11 and v_is_match then
            v_free_spins_awarded := case v_main_symbol
                when 1 then 15
                when 2 then 10
                when 3 then 5
                when 4 then 3
                when 5 then 1
            end;
        end if;
    end if;
    if v_wallet.balance_cents < v_wager then
        raise exception 'insufficient demo credits' using errcode = '22003';
    end if;
    v_balance := v_wallet.balance_cents - v_wager + v_payout;
    v_free_spins := v_wallet.free_spins_remaining
        - case when p_is_free_spin then 1 else 0 end + v_free_spins_awarded;
    v_total_wagered := v_wallet.total_wagered_cents + v_wager;
    v_total_returned := v_wallet.total_returned_cents + v_payout;

    update public.demo_wallets
    set balance_cents = v_balance,
        total_wagered_cents = v_total_wagered,
        total_returned_cents = v_total_returned,
        free_spins_remaining = v_free_spins,
        updated_at = now()
    where user_id = p_user_id;

    insert into public.demo_spins
        (user_id, request_id, bet_index, wager_cents, payout_cents,
         result_symbols, is_free_spin, balance_after_cents, total_wagered_after_cents,
         total_returned_after_cents, free_spins_after, free_spins_awarded)
    values
        (p_user_id, p_request_id, p_bet_index, v_wager, v_payout,
         p_result_symbols, p_is_free_spin, v_balance, v_total_wagered,
         v_total_returned, v_free_spins, v_free_spins_awarded);

    if v_wager > 0 then
        insert into public.demo_wallet_transactions
            (user_id, kind, amount_delta_cents, balance_after_cents, reference_id, details)
        values
            (p_user_id, 'wager', -v_wager, v_wallet.balance_cents - v_wager,
             p_request_id, jsonb_build_object('betIndex', p_bet_index));
    end if;
    if v_payout > 0 then
        insert into public.demo_wallet_transactions
            (user_id, kind, amount_delta_cents, balance_after_cents, reference_id, details)
        values
            (p_user_id, 'payout', v_payout, v_balance, p_request_id,
             jsonb_build_object('betIndex', p_bet_index));
    end if;

    return jsonb_build_object(
        'balanceCents', v_balance,
        'wagerCents', v_wager,
        'payoutCents', v_payout,
        'resultSymbols', p_result_symbols,
        'isFreeSpin', v_free_spins_awarded > 0,
        'freeSpinCount', v_free_spins_awarded,
        'freeSpinsRemaining', v_free_spins,
        'totalWageredCents', v_total_wagered,
        'totalReturnedCents', v_total_returned,
        'requestId', p_request_id
    );
end;
$$;

create or replace function public.adjust_demo_credits(
    p_user_id uuid,
    p_delta_cents bigint,
    p_reference_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_wallet public.demo_wallets%rowtype;
    v_new_balance bigint;
begin
    if p_delta_cents = 0 or abs(p_delta_cents) > 10000000 then
        raise exception 'credit adjustment out of allowed range' using errcode = '22023';
    end if;

    select * into v_wallet
    from public.demo_wallets
    where user_id = p_user_id
    for update;
    if not found then
        raise exception 'demo wallet not found' using errcode = 'P0002';
    end if;

    v_new_balance := v_wallet.balance_cents + p_delta_cents;
    if v_new_balance < 0 then
        raise exception 'adjustment would make balance negative' using errcode = '22003';
    end if;

    update public.demo_wallets
    set balance_cents = v_new_balance, updated_at = now()
    where user_id = p_user_id;

    insert into public.demo_wallet_transactions
        (user_id, kind, amount_delta_cents, balance_after_cents, reference_id, details)
    values
        (p_user_id, 'demo_credit', p_delta_cents, v_new_balance, p_reference_id,
         '{"reason":"development_admin_adjustment"}'::jsonb);
    return v_new_balance;
end;
$$;

create or replace function public.rotate_dev_socket_token(
    p_user_id uuid,
    p_token_hash text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_token_hash !~ '^[0-9a-f]{64}$' then
        raise exception 'invalid development token hash' using errcode = '22023';
    end if;

    perform 1 from auth.users where id = p_user_id for update;
    if not found then
        raise exception 'player not found' using errcode = 'P0002';
    end if;

    update public.dev_socket_tokens
    set revoked_at = now()
    where user_id = p_user_id and revoked_at is null;

    insert into public.dev_socket_tokens (token_hash, user_id)
    values (p_token_hash, p_user_id);
end;
$$;

create or replace function public.revoke_dev_socket_token(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform 1 from auth.users where id = p_user_id for update;
    if not found then
        raise exception 'player not found' using errcode = 'P0002';
    end if;

    update public.dev_socket_tokens
    set revoked_at = now()
    where user_id = p_user_id and revoked_at is null;
end;
$$;

revoke all on function public.play_demo_spin(uuid, uuid, integer, jsonb, boolean) from public, anon, authenticated;
revoke all on function public.adjust_demo_credits(uuid, bigint, uuid) from public, anon, authenticated;
revoke all on function public.rotate_dev_socket_token(uuid, text) from public, anon, authenticated;
revoke all on function public.revoke_dev_socket_token(uuid) from public, anon, authenticated;
grant execute on function public.play_demo_spin(uuid, uuid, integer, jsonb, boolean) to service_role;
grant execute on function public.adjust_demo_credits(uuid, bigint, uuid) to service_role;
grant execute on function public.rotate_dev_socket_token(uuid, text) to service_role;
grant execute on function public.revoke_dev_socket_token(uuid) to service_role;

revoke insert, update, delete on public.profiles from anon, authenticated;
revoke insert, update, delete on public.demo_wallets from anon, authenticated;
revoke insert, update, delete on public.demo_wallet_transactions from anon, authenticated;
revoke insert, update, delete on public.demo_spins from anon, authenticated;
revoke all on public.dev_socket_tokens from anon, authenticated;
grant select, insert, update, delete on public.dev_socket_tokens to service_role;
