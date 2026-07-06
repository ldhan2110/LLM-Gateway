import { getFeatureFlagOverride } from "@/lib/db/featureFlags";
import {
  FEATURE_FLAG_DEFINITIONS,
  type FeatureFlagDefinition,
} from "@/shared/constants/featureFlagDefinitions";

/**
 * Resolve the effective value of a feature flag.
 * Priority: DB override > process.env > definition.defaultValue
 */
export async function resolveFeatureFlag(key: string): Promise<string> {
  const dbOverride = await getFeatureFlagOverride(key);
  if (dbOverride !== undefined) return dbOverride;

  const envValue = process.env[key];
  if (envValue !== undefined && envValue !== "") return envValue;

  const definition = FEATURE_FLAG_DEFINITIONS.find((d) => d.key === key);
  return definition?.defaultValue ?? "false";
}

/**
 * Check if a boolean feature flag is enabled.
 * Treats "true", "1", "yes" as enabled.
 */
export async function isFeatureFlagEnabled(key: string): Promise<boolean> {
  const value = await resolveFeatureFlag(key);
  return value === "true" || value === "1" || value === "yes";
}

/**
 * Resolve all feature flags with their effective values and sources.
 */
export async function resolveAllFeatureFlags(): Promise<
  Array<{
    key: string;
    effectiveValue: string;
    source: "db" | "env" | "default";
    definition: FeatureFlagDefinition;
  }>
> {
  return Promise.all(
    FEATURE_FLAG_DEFINITIONS.map(async (definition) => {
      const dbOverride = await getFeatureFlagOverride(definition.key);
      if (dbOverride !== undefined) {
        return { key: definition.key, effectiveValue: dbOverride, source: "db" as const, definition };
      }
      const envValue = process.env[definition.key];
      if (envValue !== undefined && envValue !== "") {
        return { key: definition.key, effectiveValue: envValue, source: "env" as const, definition };
      }
      return {
        key: definition.key,
        effectiveValue: definition.defaultValue,
        source: "default" as const,
        definition,
      };
    })
  );
}

// Backward-compatible wrappers
export async function isRequireApiKeyEnabled(): Promise<boolean> {
  try {
    return await isFeatureFlagEnabled("REQUIRE_API_KEY");
  } catch (error) {
    console.error(
      "[featureFlags] Failed to resolve REQUIRE_API_KEY, defaulting to required:",
      error instanceof Error ? error.message : error
    );
    return true;
  }
}

export async function isCcCompatibleProviderEnabled(): Promise<boolean> {
  return isFeatureFlagEnabled("ENABLE_CC_COMPATIBLE_PROVIDER");
}

export async function isApiKeyRevealEnabledFlag(): Promise<boolean> {
  try {
    return await isFeatureFlagEnabled("ALLOW_API_KEY_REVEAL");
  } catch (error) {
    console.error(
      "[featureFlags] Failed to resolve ALLOW_API_KEY_REVEAL, defaulting to disabled:",
      error instanceof Error ? error.message : error
    );
    return false;
  }
}

export async function isModelCatalogNamesEnabled(): Promise<boolean> {
  return isFeatureFlagEnabled("MODEL_CATALOG_INCLUDE_NAMES");
}

export type ModelsCatalogPrefixMode = "dual" | "alias" | "canonical";

export async function getModelsCatalogPrefixMode(): Promise<ModelsCatalogPrefixMode> {
  const value = await resolveFeatureFlag("MODELS_CATALOG_PREFIX_MODE");
  if (value === "alias" || value === "canonical") return value;
  return "dual";
}

export async function isArenaEloSyncEnabled(): Promise<boolean> {
  return isFeatureFlagEnabled("ARENA_ELO_SYNC_ENABLED");
}

export async function isControlPlaneProxyDirectFallbackEnabled(): Promise<boolean> {
  try {
    return await isFeatureFlagEnabled("OMNIROUTE_CONTROL_PLANE_PROXY_DIRECT_FALLBACK");
  } catch (error) {
    console.error(
      "[featureFlags] Failed to resolve OMNIROUTE_CONTROL_PLANE_PROXY_DIRECT_FALLBACK, defaulting to disabled:",
      error instanceof Error ? error.message : error
    );
    return false;
  }
}
