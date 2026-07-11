/**
 * E2E database coordinates. The Postgres container from global-setup binds a
 * FIXED host port so playwright.config.ts can hand the dev server a static
 * DATABASE_URL at config-load time (webServer env cannot be set dynamically).
 */

export const E2E_DB_HOST_PORT = 54329;

/** PostgreSqlContainer defaults: user/pass/db = test/test/test. */
export const E2E_DATABASE_URL = `postgresql://test:test@localhost:${E2E_DB_HOST_PORT}/test`;
