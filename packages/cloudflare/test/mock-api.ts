import { vi } from "vitest";

export type Call = { method: string; url: string; body: unknown };

/** The requests that `mockFetch` answered. Each test file empties it before each test. */
export const calls: Call[] = [];

/** Answers each request with `respond`, and records it in `calls`. */
export function mockFetch(
  respond: (call: Call) => Response | Promise<Response>,
) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const call = {
      method: init?.method ?? "GET",
      url: String(url),
      body: init?.body,
    };
    calls.push(call);
    return respond(call);
  });
}

export const ok = (result: unknown = null): Response =>
  Response.json({ success: true, errors: [], result });

export const fail = (
  status: number,
  code: number,
  message = "failed",
): Response =>
  Response.json(
    { success: false, errors: [{ code, message }], result: null },
    { status },
  );
