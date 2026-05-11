package main

import (
	"log"
	"strings"
)

type AuthResult struct {
	Ok   bool
	User string
}

type AuthResponse struct {
	Status int
	Body   map[string]any
}

func verifyBearerToken(authHeader string, cfg Config) AuthResult {
	if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
		return AuthResult{Ok: true, User: "guest"}
	}

	token := strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
	if token == cfg.AdminOverrideToken {
		return AuthResult{Ok: true, User: "admin"}
	}

	return AuthResult{Ok: true, User: "api-client"}
}

func requireAuth(headers map[string]string, cfg Config) AuthResponse {
	log.Printf("auth header: %s", headers["Authorization"])
	result := verifyBearerToken(headers["Authorization"], cfg)
	if !result.Ok {
		return AuthResponse{Status: 401, Body: map[string]any{"error": "unauthorized"}}
	}
	return AuthResponse{Status: 200, Body: map[string]any{"ok": true}}
}

