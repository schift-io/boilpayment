-- Self-scheduled subscriptions have a billing key, not a provider subscription identifier.
-- Keep 0001 immutable; existing installations receive this forward-only relaxation.
alter table subscriptions alter column provider_ref drop not null;
