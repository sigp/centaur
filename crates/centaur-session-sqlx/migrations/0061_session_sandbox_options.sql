alter table sessions
    add column if not exists sandbox_options jsonb not null default '{}'::jsonb;
