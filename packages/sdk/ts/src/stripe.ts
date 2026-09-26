// Thin re-export — see ../README.md. Full surface of boilpayment-stripe (StripeProvider +
// pure normalizer functions).
//
// NOT re-exported at the package root — see root README "Root export & name collisions":
// `normalizeFailure`/`normalizeSubscription`/`normalizeRefund`/`mapEventType`/`toNormalizedEvent`
// collide (different signatures) with the same names exported by `boilpayment-sdk/polar`.
export * from 'boilpayment-stripe';
