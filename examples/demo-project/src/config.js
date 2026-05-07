function getConfig(env = process.env) {
  return {
    appName: env.APP_NAME || "checkout-service",
    jwtSecret: env.JWT_SECRET || "",
    paymentProviderUrl: env.PAYMENT_PROVIDER_URL || "https://payments.example.com",
    taxRate: Number(env.TAX_RATE || "0.08")
  };
}

module.exports = { getConfig };

