import { FormEvent, useRef, useState, useSyncExternalStore } from "react";
import { clearPubMedKey, credentialMode, credentialsVersion, setPubMedKey, subscribeCredentials } from "./credentials";
import { browserRouteSupport } from "./scheduler";

export function UserRouteControls() {
  useSyncExternalStore(subscribeCredentials, credentialsVersion);
  const keyInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const mode = credentialMode();
  const support = browserRouteSupport();
  const save = (event: FormEvent) => {
    event.preventDefault();
    try { setPubMedKey(keyInput.current?.value ?? ""); setError(""); }
    catch (error) { setError((error as Error).message); }
    finally { if (keyInput.current) keyInput.current.value = ""; }
  };
  return <details className="search-options user-route-options">
    <summary>PubMed access · This browser{mode === "personal_key" ? " · Personal key" : ""}</summary>
    {support && <p role="alert">{support}</p>}
    <p>Search and metadata requests go directly from this device to NCBI. Keep this tab open until the response is saved. Saved results remain available after closing or suspending the tab. Unsaved initial results may require a new search.</p>
    <p>Optional: use your own NCBI API key. It stays in this tab's memory and is sent only to NCBI. Re-enter it after reload. Sign out or remove it to clear it; revoke or replace it in your NCBI account.</p>
    <form onSubmit={save} autoComplete="off">
      <label>Personal NCBI API key <input ref={keyInput} type="password" autoComplete="off" autoCorrect="off" spellCheck={false} maxLength={256} aria-label="Personal NCBI API key" /></label>
      <button className="secondary">Use personal key</button>
      {mode === "personal_key" && <button type="button" className="secondary" onClick={() => { clearPubMedKey(); setError(""); }}>Remove personal key</button>}
    </form>
    {error && <p role="alert">{error}</p>}
    <p>Requests are paced across this browser profile. Other devices, profiles and applications can share your institution's IP or key limits. One user's source failure does not establish an NCBI outage. No automatic key change or server fallback occurs.</p>
    <p>Saved browser responses are labelled as client submitted, not independently source-attested. Full-text rights are evaluated separately. <a href="https://www.ncbi.nlm.nih.gov/About/disclaimer.html" target="_blank" rel="noopener noreferrer">NCBI disclaimer and copyright</a>.</p>
  </details>;
}
