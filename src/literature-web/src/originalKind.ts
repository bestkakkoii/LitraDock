import { BatchItem } from "./api";

// Requested format is deliberately not an input: only actual available file metadata permits Save.
export function originalKind(item: Pick<BatchItem, "downloadAvailable" | "original_hash" | "format" | "mediaType">): "pdf" | "xml" | null {
  if (!item.downloadAvailable || !item.original_hash) return null;
  if (item.format === "PDF" && item.mediaType === "application/pdf") return "pdf";
  if ((item.format === "XML" || !item.format) && (!item.mediaType || ["application/xml", "text/xml"].includes(item.mediaType))) return "xml";
  return null;
}
