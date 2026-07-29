// Transport-agnostic normalization for the API's shared error envelope.
//
// Lives beside `apiErrorSchema`, its only dependency: the package that owns the
// wire schema owns the reader for it. Reports, search and run-claiming all read
// this envelope and none of them are ingest, so routing them through
// @heimdall/ingest-client to parse an error body would make the ingest package
// look like the HTTP client it is not.

import { apiErrorSchema } from "./schemas";

export interface ApiFailureDetails {
  code: string;
  message: string;
}

/**
 * Read an API error without trusting an arbitrary JSON body to match the
 * server contract. Consumers wrap the normalized details in their own result
 * union, so transport semantics stay local to the calling flow.
 */
export async function readApiFailure(
  response: Response,
  fallback: string,
): Promise<ApiFailureDetails> {
  try {
    const parsed = apiErrorSchema.safeParse(await response.json());
    if (parsed.success) return parsed.data.error;
  } catch {
    // Non-JSON error body — fall through.
  }
  return { code: `http-${response.status}`, message: fallback };
}
