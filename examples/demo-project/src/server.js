const http = require("node:http");
const { requireAuth } = require("./auth");
const { calculateOrderTotal } = require("./orders");

function createServer() {
  return http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === "/orders/total" && req.method === "POST") {
      const auth = requireAuth(req);
      if (auth.status !== 200) {
        res.writeHead(auth.status, { "content-type": "application/json" });
        res.end(JSON.stringify(auth.body));
        return;
      }

      let body = "";
      req.on("data", chunk => {
        body += chunk;
      });
      req.on("end", () => {
        const payload = JSON.parse(body || "{}");
        const total = calculateOrderTotal(payload.items, payload.coupon);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ total }));
      });
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
}

module.exports = { createServer };

if (require.main === module) {
  createServer().listen(3000, () => {
    console.log("demo service listening on :3000");
  });
}

