import { Identity, type IdentityCreateConfig } from "@commontools/identity";
import env from "@/env.ts";

const ROOT = "implicit trust";

// Use noble implementation to allow identity serialization across workers
// (required for background charm service in clusterduck)
const identityConfig: IdentityCreateConfig = {
  implementation: "noble",
};

export const identity: Identity = await (async () => {
  const identityPath = env.IDENTITY;
  if (identityPath) {
    console.log(`Using identity at ${identityPath}`);
    try {
      const pkcs8Key = await Deno.readFile(identityPath);
      return await Identity.fromPkcs8(pkcs8Key, identityConfig);
    } catch (_) {
      throw new Error(`Could not read key at ${identityPath}.`);
    }
  } else if (env.IDENTITY_PASSPHRASE) {
    console.warn("Using insecure passphrase identity.");
    return await Identity.fromPassphrase(env.IDENTITY_PASSPHRASE, identityConfig);
  } else if (env.ENV === "development") {
    return await Identity.fromPassphrase(ROOT, identityConfig);
  }
  throw new Error("No IDENTITY set.");
})();
