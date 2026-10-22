import { getConfig } from '../config';
import { ProviderError } from '../errors';
import { CashfreeProvider } from './cashfree';
import { ManualUpiProvider } from './manual-upi';
import { RazorpayProvider } from './razorpay';
import { SandboxProvider } from './sandbox';
import type { PaymentProvider } from './types';

/**
 * Provider registry.
 *
 * Every provider is an independent adapter. The rest of the application only
 * ever asks the registry for an adapter by name, so onboarding a new provider
 * is a one-line registration plus its adapter file.
 */

const builtins: PaymentProvider[] = [
  new RazorpayProvider(),
  new CashfreeProvider(),
  new ManualUpiProvider(),
  new SandboxProvider(),
];

let providers = new Map<string, PaymentProvider>(builtins.map((p) => [p.name, p]));

export function listProviders(): PaymentProvider[] {
  return [...providers.values()];
}

/** Returns an adapter or throws a typed error. Never returns a stub. */
export function getProvider(name: string): PaymentProvider {
  const provider = providers.get(name);
  if (!provider) {
    throw new ProviderError(name, 'unsupported', `Unknown payment provider: ${name}`);
  }
  if (!provider.isConfigured()) {
    throw new ProviderError(name, 'not_configured', `Payment provider ${name} is not configured`);
  }
  return provider;
}

/** For read-only display: returns null instead of throwing. */
export function tryGetProvider(name: string): PaymentProvider | null {
  return providers.get(name) ?? null;
}

/** Only providers that can create a payment request for a new order. */
export function creatableProviders(): PaymentProvider[] {
  return listProviders().filter((p) => p.isConfigured() && p.capabilities.paymentRequest);
}

export function registerProvider(provider: PaymentProvider): void {
  providers.set(provider.name, provider);
}

/** Test helper: restore the built-in adapters. */
export function resetProviders(): void {
  providers = new Map<string, PaymentProvider>(builtins.map((p) => [p.name, p]));
}

/** Runtime guard — the sandbox adapter must never be reachable in production. */
export function assertProviderAllowed(name: string): void {
  if (name === 'sandbox') {
    const config = getConfig();
    if (config.isProduction || !config.allowSandboxProvider) {
      throw new ProviderError('sandbox', 'unsupported', 'Sandbox provider is not available');
    }
  }
}

export function providerPublicInfo(): Array<{
  name: string;
  displayName: string;
  configured: boolean;
  simulated: boolean;
  capabilities: PaymentProvider['capabilities'];
}> {
  return listProviders().map((p) => ({
    name: p.name,
    displayName: p.displayName,
    configured: p.isConfigured(),
    simulated: p.capabilities.simulated,
    capabilities: p.capabilities,
  }));
}
