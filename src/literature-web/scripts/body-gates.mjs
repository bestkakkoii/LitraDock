// Browser-only SYNTHETIC scheduling helper. Gates the body path actually consumed
// by production Fetch readers; cancellation is observed, never a replacement file.
export function installBodyGates({ mode = "exports" } = {}) {
  const originalFetch = window.fetch.bind(window);
  window.__holds = {};
  window.fetch = async (...args) => {
    const url = String(args[0]);
    const gate = mode === "pdf" ? window.__holdOriginal && url.includes("/originals/") ? "original" : undefined
      : url.endsWith("/exports") ? window.__nextHold : undefined;
    if (gate && mode !== "pdf") window.__nextHold = undefined;
    const response = await originalFetch(...args);
    if (!gate) return response;
    const wait = () => new Promise(resolve => {
      const release = () => { release.released = true; resolve(); };
      release.release = release;
      if (mode === "pdf") { window.__bodyStarted = true; window.__releaseBody = release; }
      else window.__holds[gate] = release;
    });
    if (!response.ok) {
      const text = response.text.bind(response);
      response.text = async () => { const body = await text(); await wait(); return body; };
    } else {
      const reader = response.body.getReader();
      let gated = false, cancelled = false;
      const body = new ReadableStream({
        async pull(controller) {
          try {
            const part = await reader.read();
            if (!gated) { gated = true; await wait(); }
            if (cancelled) return;
            if (part.done) controller.close(); else controller.enqueue(part.value);
          } catch (error) { if (!cancelled) controller.error(error); }
        },
        cancel() { cancelled = true; return reader.cancel(); },
      });
      Object.defineProperty(response, "body", { value: body });
    }
    return response;
  };
}
