import SteamUser from "steam-user";

/**
 * The only file that touches the Steam network.
 *
 * Kept deliberately thin so `parse.ts` and `collect.ts` stay testable without a
 * connection. Login is ANONYMOUS: public appinfo needs no account, so there is
 * no credential to store, leak, or get rate-limited on. Measured login time is
 * well under a second, which is why this runs as a periodic job rather than a
 * long-lived service.
 */

const LOGIN_TIMEOUT_MS = 45_000;
const CALL_TIMEOUT_MS = 120_000;

export interface ProductInfoApp {
  changenumber: number | null;
  appinfo: unknown;
}

export interface SteamClient {
  getProductChanges(since: number): Promise<{ currentChangeNumber: number; appIds: number[] }>;
  getProductInfo(appids: readonly number[]): Promise<Map<number, ProductInfoApp>>;
  close(): void;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export async function connectAnonymously(): Promise<SteamClient> {
  // `dataDirectory: null` keeps this stateless — nothing is written to disk, so
  // a CI runner and a laptop behave identically and no sentry file accumulates.
  const client = new SteamUser({ dataDirectory: null, autoRelogin: false });

  await withTimeout(
    new Promise<void>((resolve, reject) => {
      client.once("loggedOn", () => resolve());
      client.once("error", (error: Error) => reject(error));
      client.logOn({ anonymous: true });
    }),
    LOGIN_TIMEOUT_MS,
    "steam anonymous login",
  );

  return {
    async getProductChanges(since: number) {
      const response = await withTimeout(
        client.getProductChanges(since),
        CALL_TIMEOUT_MS,
        "getProductChanges",
      );
      const appIds = Object.keys(response.appChanges ?? {})
        .map((key) => Number(key))
        .filter((appid) => Number.isSafeInteger(appid) && appid > 0);
      return { currentChangeNumber: Number(response.currentChangeNumber) || 0, appIds };
    },

    async getProductInfo(appids: readonly number[]) {
      const out = new Map<number, ProductInfoApp>();
      if (appids.length === 0) return out;
      const response = await withTimeout(
        client.getProductInfo([...appids], [], true),
        CALL_TIMEOUT_MS,
        "getProductInfo",
      );
      for (const [key, value] of Object.entries(response.apps ?? {})) {
        const appid = Number(key);
        if (!Number.isSafeInteger(appid)) continue;
        const entry = value as { changenumber?: unknown; appinfo?: unknown };
        const changenumber = Number(entry.changenumber);
        out.set(appid, {
          changenumber: Number.isSafeInteger(changenumber) ? changenumber : null,
          appinfo: entry.appinfo,
        });
      }
      return out;
    },

    close() {
      try {
        client.logOff();
      } catch {
        // Closing a already-dead connection must never fail the run.
      }
    },
  };
}
