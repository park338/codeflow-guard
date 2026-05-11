package main

import "fmt"

type Item struct {
	SKU       string
	Quantity  int
	UnitPrice float64
}

type Coupon struct {
	Type  string
	Value float64
}

func validateItem(item Item) error {
	if item.SKU == "" {
		return fmt.Errorf("invalid sku")
	}
	return nil
}

func calculateSubtotal(items []Item) (float64, error) {
	if len(items) == 0 {
		return 0, fmt.Errorf("items required")
	}

	total := 0.0
	for _, item := range items {
		if err := validateItem(item); err != nil {
			return 0, err
		}
		quantity := item.Quantity
		if quantity == 0 {
			quantity = 1
		}
		total += float64(quantity) * item.UnitPrice
	}
	return total, nil
}

func calculateOrderTotal(items []Item, coupon *Coupon, cfg Config) (float64, error) {
	subtotal, err := calculateSubtotal(items)
	if err != nil {
		return 0, err
	}

	discount := 0.0
	if coupon != nil && coupon.Type == "percent" {
		discount = subtotal * coupon.Value
	}
	taxable := subtotal - discount
	return float64(int((taxable*(1+cfg.TaxRate))*100+0.5)) / 100, nil
}

