/**
 * Minimal ambient types for `steam-user`, which ships none.
 *
 * Deliberately narrow: this declares only the surface `steam.ts` actually
 * calls, so the compiler still catches a typo or an argument in the wrong
 * position. Widening it to `any` would delete exactly the checking this file
 * exists to provide.
 *
 * The PICS response bodies stay `unknown` on purpose. Steam sends every scalar
 * as a string and changes shapes without notice, so `parse.ts` narrows them
 * explicitly rather than trusting a declaration written from observation.
 */
declare module "steam-user" {
  interface SteamUserOptions {
    /** `null` keeps the client stateless — nothing written to disk. */
    dataDirectory?: string | null;
    autoRelogin?: boolean;
  }

  interface LogOnDetails {
    anonymous?: boolean;
  }

  interface ProductChangesResponse {
    currentChangeNumber: number;
    appChanges?: Record<string, unknown>;
    packageChanges?: Record<string, unknown>;
    forceFullUpdate?: boolean;
  }

  interface ProductInfoResponse {
    apps?: Record<string, unknown>;
    packages?: Record<string, unknown>;
    unknownApps?: number[];
    unknownPackages?: number[];
  }

  class SteamUser {
    constructor(options?: SteamUserOptions);
    steamID?: { getSteamID64(): string } | null;
    logOn(details?: LogOnDetails): void;
    logOff(): void;
    once(event: "loggedOn", listener: () => void): this;
    once(event: "error", listener: (error: Error) => void): this;
    on(event: "loggedOn", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    getProductChanges(sinceChangenumber: number): Promise<ProductChangesResponse>;
    getProductInfo(
      apps: number[],
      packages: number[],
      inclToken?: boolean,
    ): Promise<ProductInfoResponse>;
  }

  export = SteamUser;
}
