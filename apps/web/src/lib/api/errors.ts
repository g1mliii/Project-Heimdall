/** Browser-safe normalization for the API's shared error envelope. */

import { apiErrorSchema } from "@heimdall/shared";

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
