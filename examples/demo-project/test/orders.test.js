const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateOrderTotal } = require("../src/orders");

test("calculates total with tax", () => {
  const total = calculateOrderTotal(
    [{ sku: "book", quantity: 2, unitPrice: 20 }],
    null,
    { taxRate: 0.1 }
  );
  assert.equal(total, 44);
});

test("caps percent coupons at 50 percent", () => {
  const total = calculateOrderTotal(
    [{ sku: "book", quantity: 1, unitPrice: 100 }],
    { type: "percent", value: 0.9 },
    { taxRate: 0 }
  );
  assert.equal(total, 50);
});

test("rejects negative quantity", () => {
  assert.throws(() => {
    calculateOrderTotal([{ sku: "book", quantity: -1, unitPrice: 20 }]);
  }, /invalid quantity/);
});

