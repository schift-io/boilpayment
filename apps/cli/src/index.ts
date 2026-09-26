// Public programmatic API of @schift/payment-kit (the CLI package). Most users run the
// `paykit` binary (see bin.ts/cli.ts); this export surface is for scripting the wizard.
export * from './config.js';
export * from './questions.js';
export { runWizard, type WizardOptions } from './wizard.js';
export { generateAll, type GenerateResult } from './generate/index.js';
