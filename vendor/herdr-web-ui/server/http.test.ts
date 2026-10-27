import { describe, expect, it } from "bun:test";

import { HerdrError } from "./herdr/client.ts";
import { errorResponse } from "./http.ts";

describe("errorResponse", () => {
  it("answers a 500 with a fixed message and a correlation id, never the exception's own", async () => {
    const secret = "ENOENT: no such file or directory, open '/home/someone/.config/herdr-web-ui/devices.json'";
    const response = errorResponse(new Error(secret));
    expect(response.status).toBe(500);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).not.toContain("ENOENT");
    expect(body.error.message).not.toContain("/home/");
    // the handle the user can quote, and one answer per failure
    expect(body.error.message).toMatch(/^internal error \([0-9a-f]{12}\)$/);
    expect(errorResponse(new Error(secret)).status).toBe(500);
    const second = await errorResponse(new Error(secret)).json() as { error: { message: string } };
    expect(second.error.message).not.toBe(body.error.message);
  });

  it("keeps an authored HerdrError message as it is", async () => {
    const connect = await errorResponse(new HerdrError("connect_failed", "herdr is not answering")).json() as { error: { code: string; message: string } };
    expect(errorResponse(new HerdrError("connect_failed", "herdr is not answering")).status).toBe(502);
    expect(connect.error).toEqual({ code: "connect_failed", message: "herdr is not answering" });
    expect(errorResponse(new HerdrError("pane_not_found", "no such pane")).status).toBe(404);
  });
});