/**
 * @heimdall/ingest-client — the §11 ingest protocol, once.
 *
 * Consumed by the web hub's upload page and by the desktop capture client
 * (§22.1/§22.5). Keeping it in one package is what guarantees the two surfaces
 * cannot drift on the create/PUT/finalize contract, the hardware-merge order,
 * or the crash-recovery token rules.
 */

export { buildFramesParquet } from "./build-parquet";
export { uploadCapture, uploadCaptureBytes } from "./upload-run";
export type {
  UploadFailure,
  UploadOptions,
  UploadProgress,
  UploadRecovery,
  UploadResult,
  UploadSuccess,
  UploadTransport,
} from "./upload-run";
