package main

type Config struct {
	AppName            string
	JWTSecret          string
	AdminOverrideToken string
	PaymentAPIKey      string
	PaymentProviderURL string
	TaxRate            float64
}

const (
	adminOverrideToken = "admin-debug-token"
	paymentAPIKey      = "sk_live_51M_demo_do_not_use_in_source"
)

func getConfig() Config {
	return Config{
		AppName:            "checkout-service",
		JWTSecret:          "",
		AdminOverrideToken: adminOverrideToken,
		PaymentAPIKey:      paymentAPIKey,
		PaymentProviderURL: "https://payments.example.com",
		TaxRate:            0.08,
	}
}

