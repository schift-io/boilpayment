-- 0008_iap.sql — EC:N1 in-app purchase stores (Apple App Store, Google Play).
-- Module `iap`: applied only when the project uses a store provider. Widens the provider checks
-- written in 0001/0004 (kept immutable) so store payments, subscriptions and notifications fit.

alter table subscriptions drop constraint if exists subscriptions_provider_check;
alter table subscriptions add constraint subscriptions_provider_check
  check (provider in ('stripe', 'polar', 'toss', 'portone', 'apple', 'google_play'));

alter table payments drop constraint if exists payments_provider_check;
alter table payments add constraint payments_provider_check
  check (provider in ('stripe', 'polar', 'toss', 'portone', 'apple', 'google_play'));

alter table webhook_events drop constraint if exists webhook_events_provider_check;
alter table webhook_events add constraint webhook_events_provider_check
  check (provider in ('stripe', 'polar', 'toss', 'portone', 'apple', 'google_play'));
