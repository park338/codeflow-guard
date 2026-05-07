const { getConfig } = require("./config");

function validateItem(item) {
  if (!item || typeof item.sku !== "string" || item.sku.length === 0) {
    throw new Error("invalid sku");
  }
  if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
    throw new Error("invalid quantity");
  }
  if (typeof item.unitPrice !== "number" || item.unitPrice < 0) {
    throw new Error("invalid price");
  }
}

function calculateSubtotal(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("items required");
  }

  return items.reduce((sum, item) => {
    validateItem(item);
    return sum + item.quantity * item.unitPrice;
  }, 0);
}

function calculateOrderTotal(items, coupon = null, config = getConfig()) {
  const subtotal = calculateSubtotal(items);
  const discount = coupon && coupon.type === "percent"
    ? subtotal * Math.min(Math.max(coupon.value, 0), 0.5)
    : 0;
  const taxableAmount = subtotal - discount;
  return Number((taxableAmount * (1 + config.taxRate)).toFixed(2));
}

module.exports = { calculateOrderTotal, calculateSubtotal };

