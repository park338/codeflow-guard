const { getConfig } = require("./config");

function verifyBearerToken(authHeader, config = getConfig()) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { ok: false, reason: "missing token" };
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!config.jwtSecret || token !== config.jwtSecret) {
    return { ok: false, reason: "invalid token" };
  }

  return { ok: true };
}

function requireAuth(req) {
  const result = verifyBearerToken(req.headers.authorization);
  if (!result.ok) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  return { status: 200, body: { ok: true } };
}

module.exports = { requireAuth, verifyBearerToken };

