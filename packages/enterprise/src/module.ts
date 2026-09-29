export const enterpriseModule = {
  id: "enterprise",
  requires: [],
  provides: ["enterprise-store", "enterprise-auth"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
