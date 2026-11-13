import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, api } from "./api";

test("ApiError keeps module_hidden roles for the recovery link", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "目前沒有開啟", code: "module_hidden", module: "lms", feature: "assignments", roles: ["student"] }), { status: 409, headers: { "Content-Type": "application/json" } }));
  await assert.rejects(api("/lms/assignments"), (cause) => {
    assert.ok(cause instanceof ApiError);
    assert.equal(cause.status, 409);
    assert.equal(cause.code, "module_hidden");
    assert.deepEqual(cause.roles, ["student"]);
    return true;
  });
});

test("ApiError distinguishes an invalid key from no credit", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "server wording must not drive copy", code: "ai_key_no_credit" }), { status: 422, headers: { "Content-Type": "application/json" } }));
  await assert.rejects(api("/ai/connections/keys/openai"), (cause) => {
    assert.ok(cause instanceof ApiError);
    assert.equal(cause.code, "ai_key_no_credit");
    return true;
  });
});
