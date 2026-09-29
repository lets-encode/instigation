import type { ForgeClient } from "../forge/types.ts";

export type ForgeOverrides = Partial<{
  [K in keyof ForgeClient]: ForgeClient[K];
}>;

// A ForgeClient whose unstubbed methods throw on call.
export function fakeForge(overrides: ForgeOverrides): ForgeClient {
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return target[property as keyof ForgeOverrides];
      return () => {
        throw new Error(`Unexpected forge call: ${String(property)}`);
      };
    },
  }) as ForgeClient;
}
