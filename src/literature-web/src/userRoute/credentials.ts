export type CredentialMode = "unkeyed" | "personal_key";
let personalKey = "";
let credentialVersion = 0;
const listeners = new Set<() => void>();
export const credentialMode = (): CredentialMode => personalKey ? "personal_key" : "unkeyed";
export const credentialsVersion = () => credentialVersion;
export const subscribeCredentials = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function clearPubMedKey() { personalKey = ""; credentialVersion++; listeners.forEach(listener => listener()); }
export function setPubMedKey(value: string) {
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(value)) throw new Error("Enter your complete NCBI API key without spaces.");
  personalKey = value; credentialVersion++; listeners.forEach(listener => listener());
}
// The secret has no serialization API. Only the fixed provider transport reads it.
export function providerKey(mode: CredentialMode): string {
  if (mode === "personal_key" && !personalKey) throw new Error("Re-enter your personal NCBI key for this run. No unkeyed or server fallback will be used.");
  if (mode === "unkeyed" && personalKey) throw new Error("This run was admitted without a key. Remove the key explicitly to resume it, or create a separate search.");
  return mode === "personal_key" ? personalKey : "";
}
