// Thin re-export — see ../README.md. Full surface of @schift/payment-kit-refund (evaluate,
// execute, onExternalRefund, proration/rounding utilities).
//
// NOTE — name collision (see root README "Root export & name collisions"): this module's
// `prorationRatio` is a DIFFERENT function than @schift/payment-kit-core's `prorationRatio`
// (also re-exported at the package root, `@schift/payment-kit-sdk`). Importing both this subpath
// and the root in the same file will shadow one with the other — pick one explicitly if you need
// both, e.g. `import { prorationRatio as refundProrationRatio } from '@schift/payment-kit-sdk/refund'`.
export * from '@schift/payment-kit-refund';
