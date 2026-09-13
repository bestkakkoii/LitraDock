export type TransferProgress = { received: number; total?: number };
export type TransferOptions = { maxBytes?: number; onProgress?: (value: TransferProgress) => void };

// Fetch exposes decoded bytes. Encoded Content-Length is not their denominator.
export async function readTransfer(response: Response, signal: AbortSignal | null | undefined,
  current: () => void, options: TransferOptions = {}): Promise<Blob> {
  const maxBytes = options.maxBytes ?? 37 * 1024 * 1024;
  const encoding = response.headers?.get("Content-Encoding");
  const declared = response.headers?.get("Content-Length");
  let total = (!encoding || encoding.toLowerCase() === "identity") && declared && /^\d+$/.test(declared)
    ? Number(declared) : undefined;
  if (!Number.isSafeInteger(total) || !total) total = undefined;
  if (total !== undefined && total > maxBytes) {
    await response.body?.cancel(); current();
    throw new Error("Download exceeds the permitted byte limit. No file was saved.");
  }
  const report = (received: number) => { current(); options.onProgress?.({ received, total }); current(); };
  // Older test transports may provide only blob(); this is not streamed progress.
  if (!response.body) {
    const blob = await response.blob(); current();
    if (blob.size > maxBytes) throw new Error("Download exceeds the permitted byte limit. No file was saved.");
    if (total !== undefined && total !== blob.size) throw new Error("Incomplete download. No file was saved.");
    report(blob.size); return blob;
  }
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort);
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let received = 0;
  try {
    current(); report(0);
    while (true) {
      const part = await reader.read(); current();
      if (part.done) break;
      received += part.value.byteLength;
      if (received > maxBytes) throw new Error("Download exceeds the permitted byte limit. No file was saved.");
      if (total !== undefined && received > total) throw new Error("Download length did not match. No file was saved.");
      chunks.push(new Uint8Array(part.value)); report(received);
    }
    if (total !== undefined && received !== total) throw new Error("Incomplete download. No file was saved.");
    current();
    return new Blob(chunks, { type: response.headers.get("Content-Type") ?? "" });
  } catch (error) {
    await reader.cancel().catch(() => {});
    current(); throw error;
  } finally { signal?.removeEventListener("abort", abort); reader.releaseLock(); }
}

export function transferLabel(value: TransferProgress) {
  const bytes = `${value.received.toLocaleString()} bytes received`;
  return value.total === undefined ? bytes
    : `${bytes} of ${value.total.toLocaleString()} (${Math.floor(value.received / value.total * 100)}%)`;
}
