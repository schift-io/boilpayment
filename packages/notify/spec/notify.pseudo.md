# notify — spec (source of truth)

Public API: `resend`, `smtp`, `slack`, `composite`, `templates`, `withOutbox`,
`flushNotifyOutbox`. All adapters implement core's `Notifier` interface
(`send(n: Notification) -> Promise<void>`), used by `lifecycle.dunning`,
`refund`, `cs`, `usage.check` (soft-cap) etc.

Rule for every adapter (no EC id — cross-cutting reliability rule from the
brief): **send() never throws on transport failure.** Network/API errors are
logged (stderr / logging) and swallowed, so a flaky email provider can never
break the business flow (dunning, refund, webhook processing) that triggered
the notification.

---

## Templates — per NotifyType, EN + KO

```pseudo
templates: Record<NotifyType, { en: (payload) -> {subject, text}, ko: (payload) -> {subject, text} }>

# NotifyType (from core): payment.failed, grace.started, grace.ending,
# subscription.canceled, refund.executed, cs.needs_human, reconcile.mismatch,
# card.expiring, usage.soft_cap
#
# Each template is a plain string with `{field}` interpolation against
# `payload` (simple string templates, no templating engine dependency).
render(type, locale, payload) -> { subject, text }
  tpl = templates[type][locale] ?? templates[type]['en']
  return tpl(payload)
```

## resend adapter — Resend email API

```pseudo
resend({ apiKey, from, to, locale = 'en' }) -> Notifier

send(n):
   { subject, text } = render(n.type, locale, n.payload)
   recipient = n.payload.email ?? to
   try:
      POST https://api.resend.com/emails
        headers: { Authorization: 'Bearer ' + apiKey, Content-Type: 'application/json' }
        body: { from, to: recipient, subject, text }
      # fetch (ts) / httpx.AsyncClient (py)
   except Exception as e:
      log.error('notify.resend failed', e)   # never throw
```

## smtp adapter — nodemailer (ts) / smtplib (py)

```pseudo
smtp({ host, port, secure = false, auth?: { user, pass }, from, to, locale = 'en' }) -> Notifier

send(n):
   { subject, text } = render(n.type, locale, n.payload)
   recipient = n.payload.email ?? to
   try:
      transporter.sendMail({ from, to: recipient, subject, text })   # ts: nodemailer.createTransport
      # py: smtplib.SMTP(host, port) [+ starttls if secure] + auth.login + sendmail,
      #     run via asyncio.to_thread since smtplib is sync
   except Exception as e:
      log.error('notify.smtp failed', e)   # never throw
```

## slack adapter — incoming webhook

```pseudo
slack({ webhookUrl, locale = 'en' }) -> Notifier

send(n):
   { subject, text } = render(n.type, locale, n.payload)
   try:
      POST webhookUrl body: { text: '*' + subject + '*\n' + text }
   except Exception as e:
      log.error('notify.slack failed', e)   # never throw — e.g. unreachable URL
```

## composite — fan-out

```pseudo
composite(notifiers: Notifier[]) -> Notifier

send(n):
   async deliver(nt): await nt.send(n)
   results = await allSettled(notifiers.map(nt -> deliver(nt)))   # ts: Promise.allSettled
   # py: asyncio.gather(*[deliver(nt) for nt in notifiers], return_exceptions=True)
   # Invoke children inside async boundaries: synchronous throws and rejected awaits
   # are isolated per child. Every healthy sibling receives the notification.
   # each underlying notifier already swallows its own errors per the rule above,
   # so allSettled/gather here is defense in depth, not the primary guarantee.
```

## withOutbox — durable delivery via repo.outbox

```pseudo
withOutbox(notifier: Notifier, repo) -> Notifier

send(n):
   repo.outbox.put(OutboxItem{
     id: <caller-independent id — generated here via crypto random / uuid4>,
     kind: 'notify', payload: { notification: n },
     status: 'pending', attempts: 0, nextAttemptAt: now(), createdAt: now(),
   })
   # never throws — enqueue is local/in-process (or to whatever repo is), the
   # actual send happens later via flushNotifyOutbox.

flushNotifyOutbox({ repo, notifier, clock, maxAttempts = 8 }) -> { sent: int, failed: int, retried: int }
   pending = repo.outbox.list({ kind: 'notify', status: 'pending' })
   now = clock.now()
   for item in pending:
      if item.nextAttemptAt > now: continue
      try:
         notifier.send(item.payload.notification)   # underlying notifier never throws (rule above),
         item.status = 'sent'                        # so this branch is effectively always taken;
      except Exception as e:                          # kept for defense in depth / non-conforming notifiers
         item.attempts += 1
         if item.attempts >= maxAttempts: item.status = 'failed'
         else: item.status = 'pending'; item.nextAttemptAt = now + backoff(item.attempts)
      repo.outbox.put(item)
```
