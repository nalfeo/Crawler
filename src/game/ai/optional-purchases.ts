export interface OptionalPurchasesConfig {
  optionalPurchases?: boolean;
  merchantWeaponPurchase?: boolean;
  spellBrokerPurchase?: boolean;
}

export const DEFAULT_OPTIONAL_PURCHASES = true;

export function resolveOptionalPurchases(config: OptionalPurchasesConfig): boolean {
  if (config.optionalPurchases !== undefined) {
    return config.optionalPurchases;
  }
  if (config.merchantWeaponPurchase !== undefined || config.spellBrokerPurchase !== undefined) {
    return (config.merchantWeaponPurchase ?? false) || (config.spellBrokerPurchase ?? false);
  }
  return DEFAULT_OPTIONAL_PURCHASES;
}
