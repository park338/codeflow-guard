const test = require("node:test");
const assert = require("node:assert/strict");
const { verifyBearerToken } = require("../src/auth");

test("rejects missing authorization header", () => {
  const result = verifyBearerToken("", { jwtSecret: "demo-token" });
  assert.equal(result.ok, false);
});

test("rejects invalid bearer token", () => {
  const result = verifyBearerToken("Bearer wrong", { jwtSecret: "demo-token" });
  assert.equal(result.ok, false);
});

test("accepts valid bearer token", () => {
  const result = verifyBearerToken("Bearer demo-token", { jwtSecret: "demo-token" });
  assert.equal(result.ok, true);
});

