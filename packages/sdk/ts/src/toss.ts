// Thin re-export — see ../README.md. Full surface of boilpayment-toss (TossProvider +
// pure normalizer functions + cash-receipt types).
//
// NOT re-exported at the package root — see root README "Root export & name collisions":
// `CashReceiptType`/`CashReceiptStatus`/`CashReceipt` collide (different shapes) with the same
// names exported by `boilpayment-sdk/portone`.
export * from 'boilpayment-toss';
