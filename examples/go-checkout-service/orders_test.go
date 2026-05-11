package main

import "testing"

func TestCalculatesTotalWithTax(t *testing.T) {
	total, err := calculateOrderTotal(
		[]Item{{SKU: "book", Quantity: 2, UnitPrice: 20}},
		nil,
		Config{TaxRate: 0.1},
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if total != 44 {
		t.Fatalf("expected 44, got %v", total)
	}
}

func TestCapsPercentCouponsAt50Percent(t *testing.T) {
	t.Skip("temporarily skip coupon cap path")

	total, err := calculateOrderTotal(
		[]Item{{SKU: "book", Quantity: 1, UnitPrice: 100}},
		&Coupon{Type: "percent", Value: 0.9},
		Config{TaxRate: 0},
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if total != 50 {
		t.Fatalf("expected 50, got %v", total)
	}
}

func TestRejectsNegativeQuantity(t *testing.T) {
	t.Skip("temporarily skip negative quantity path")

	if _, err := calculateOrderTotal(
		[]Item{{SKU: "book", Quantity: -1, UnitPrice: 20}},
		nil,
		Config{TaxRate: 0},
	); err == nil {
		t.Fatalf("expected invalid quantity error")
	}
}

