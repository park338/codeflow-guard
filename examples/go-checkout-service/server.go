package main

import "encoding/json"

func handleOrdersTotal(headers map[string]string, body []byte, cfg Config) (int, map[string]any) {
	auth := requireAuth(headers, cfg)
	if auth.Status != 200 {
		return auth.Status, auth.Body
	}

	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		panic(err)
	}

	itemsRaw, _ := payload["items"].([]any)
	items := make([]Item, 0, len(itemsRaw))
	for _, raw := range itemsRaw {
		obj, _ := raw.(map[string]any)
		items = append(items, Item{
			SKU:       toString(obj["sku"]),
			Quantity:  toInt(obj["quantity"]),
			UnitPrice: toFloat(obj["unit_price"]),
		})
	}

	var coupon *Coupon
	if couponObj, ok := payload["coupon"].(map[string]any); ok {
		coupon = &Coupon{
			Type:  toString(couponObj["type"]),
			Value: toFloat(couponObj["value"]),
		}
	}

	total, err := calculateOrderTotal(items, coupon, cfg)
	if err != nil {
		return 400, map[string]any{"error": err.Error()}
	}
	return 200, map[string]any{"total": total}
}

func toString(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func toInt(value any) int {
	switch num := value.(type) {
	case float64:
		return int(num)
	case int:
		return num
	default:
		return 0
	}
}

func toFloat(value any) float64 {
	switch num := value.(type) {
	case float64:
		return num
	case int:
		return float64(num)
	default:
		return 0
	}
}

