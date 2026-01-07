# WhatEat Authentication API

**Base URL:** `https://whateatbe.onrender.com/api/v1`

## Overview

The authentication system uses a unified endpoint that supports multiple OAuth providers (Apple, Google). After successful authentication, the API returns access and refresh tokens that should be stored securely in the iOS Keychain.

---

## Endpoints

### 1. Sign In

Exchange an OAuth provider's identity token for session tokens.

```
POST /auth/signin
```

#### Request Headers

| Header | Value |
|--------|-------|
| `Content-Type` | `application/json` |

#### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | `string` | Yes | OAuth provider: `"apple"` or `"google"` |
| `idToken` | `string` | Yes | Identity token from the OAuth provider |
| `fullName` | `object` | No | User's name (Apple only, first sign-in only) |
| `fullName.givenName` | `string` | No | User's first name |
| `fullName.familyName` | `string` | No | User's last name |

#### Example Request (Apple Sign In)

```json
{
  "provider": "apple",
  "idToken": "eyJraWQiOiJXNldjT0tCIiwiYWxnIjoiUlMyNTYifQ...",
  "fullName": {
    "givenName": "Diego",
    "familyName": "Smith"
  }
}
```

#### Success Response (200 OK)

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "v1.MjQ0YzYwZGUtZGQzNi00YjJhLWI...",
  "expiresIn": 3600,
  "expiresAt": 1736197200,
  "user": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "email": "user@example.com",
    "createdAt": "2026-01-06T12:00:00.000Z"
  }
}
```

#### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `accessToken` | `string` | JWT for authenticating API requests (valid ~1 hour) |
| `refreshToken` | `string` | Token for obtaining new access tokens (valid ~30 days) |
| `expiresIn` | `number` | Access token lifetime in seconds |
| `expiresAt` | `number` | Access token expiration as Unix timestamp |
| `user.id` | `string` | Unique user identifier (UUID) |
| `user.email` | `string?` | User's email (may be null if hidden via Apple) |
| `user.createdAt` | `string` | Account creation timestamp (ISO 8601) |

#### Error Responses

| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_PROVIDER` | Provider must be "apple" or "google" |
| 400 | `MISSING_TOKEN` | `idToken` field is required |
| 401 | `AUTH_FAILED` | Invalid or expired identity token |
| 500 | `AUTH_SERVICE_ERROR` | Server error during authentication |

---

### 2. Refresh Token

Get new tokens when the access token expires. Call this when you receive a 401 response from protected endpoints.

```
POST /auth/refresh
```

#### Request Headers

| Header | Value |
|--------|-------|
| `Content-Type` | `application/json` |

#### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `refreshToken` | `string` | Yes | The refresh token from sign in |

#### Example Request

```json
{
  "refreshToken": "v1.MjQ0YzYwZGUtZGQzNi00YjJhLWI..."
}
```

#### Success Response (200 OK)

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "v1.NWE3YjJkMTAtYWIzYy00ZDVl...",
  "expiresIn": 3600,
  "expiresAt": 1736200800,
  "user": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "email": "user@example.com",
    "createdAt": "2026-01-06T12:00:00.000Z"
  }
}
```

> **Note:** Both `accessToken` and `refreshToken` are rotated. Store the new refresh token for future use.

#### Error Responses

| Status | Code | Description |
|--------|------|-------------|
| 400 | `MISSING_REFRESH_TOKEN` | `refreshToken` field is required |
| 401 | `INVALID_REFRESH_TOKEN` | Refresh token is invalid or expired |
| 500 | `REFRESH_SERVICE_ERROR` | Server error during token refresh |

---

### 3. Sign Out

Sign out the current user and invalidate their session.

```
POST /auth/signout
```

#### Request Headers

| Header | Value |
|--------|-------|
| `Content-Type` | `application/json` |
| `Authorization` | `Bearer <accessToken>` |

#### Request Body

Empty or `{}`

#### Success Response (200 OK)

```json
{
  "success": true
}
```

#### Error Responses

| Status | Code | Description |
|--------|------|-------------|
| 401 | - | Missing or invalid authorization header |
| 401 | - | Access token expired (refresh first, then retry) |

---

## iOS Integration Guide

### 1. Sign In with Apple Flow

```swift
import AuthenticationServices

class AuthManager: NSObject {
    static let shared = AuthManager()
    
    private let baseURL = "https://whateatbe.onrender.com/api/v1"
    
    // Stored tokens
    private(set) var accessToken: String?
    private(set) var refreshToken: String?
    private(set) var expiresAt: Date?
    
    // MARK: - Sign In with Apple
    
    func signInWithApple() {
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.email, .fullName]
        
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.performRequests()
    }
}

extension AuthManager: ASAuthorizationControllerDelegate {
    func authorizationController(controller: ASAuthorizationController,
                                  didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let identityToken = credential.identityToken,
              let tokenString = String(data: identityToken, encoding: .utf8) else {
            return
        }
        
        Task {
            await handleAppleSignIn(
                idToken: tokenString,
                fullName: credential.fullName
            )
        }
    }
    
    private func handleAppleSignIn(idToken: String, fullName: PersonNameComponents?) async {
        var body: [String: Any] = [
            "provider": "apple",
            "idToken": idToken
        ]
        
        // Apple only sends name on FIRST sign-in - capture it!
        if let fullName = fullName,
           (fullName.givenName != nil || fullName.familyName != nil) {
            body["fullName"] = [
                "givenName": fullName.givenName as Any,
                "familyName": fullName.familyName as Any
            ]
        }
        
        do {
            let response = try await post(path: "/auth/signin", body: body)
            saveTokens(from: response)
            print("✅ Signed in as: \(response.user.id)")
        } catch {
            print("❌ Sign in failed: \(error)")
        }
    }
}
```

### 2. Token Storage (Keychain)

```swift
extension AuthManager {
    private func saveTokens(from response: AuthResponse) {
        accessToken = response.accessToken
        refreshToken = response.refreshToken
        expiresAt = Date(timeIntervalSince1970: TimeInterval(response.expiresAt))
        
        // Save to Keychain for persistence
        KeychainHelper.save(key: "accessToken", value: response.accessToken)
        KeychainHelper.save(key: "refreshToken", value: response.refreshToken)
        KeychainHelper.save(key: "expiresAt", value: String(response.expiresAt))
    }
    
    func loadTokensFromKeychain() {
        accessToken = KeychainHelper.load(key: "accessToken")
        refreshToken = KeychainHelper.load(key: "refreshToken")
        if let expiresAtString = KeychainHelper.load(key: "expiresAt"),
           let timestamp = TimeInterval(expiresAtString) {
            expiresAt = Date(timeIntervalSince1970: timestamp)
        }
    }
    
    func clearTokens() {
        accessToken = nil
        refreshToken = nil
        expiresAt = nil
        KeychainHelper.delete(key: "accessToken")
        KeychainHelper.delete(key: "refreshToken")
        KeychainHelper.delete(key: "expiresAt")
    }
}
```

### 3. Automatic Token Refresh

```swift
extension AuthManager {
    /// Returns a valid access token, refreshing if needed
    func getValidAccessToken() async throws -> String {
        // Check if current token is valid (with 5 min buffer)
        if let token = accessToken,
           let expires = expiresAt,
           expires > Date().addingTimeInterval(300) {
            return token
        }
        
        // Need to refresh
        guard let refresh = refreshToken else {
            throw AuthError.notLoggedIn
        }
        
        return try await refreshTokens(refresh)
    }
    
    private func refreshTokens(_ refreshToken: String) async throws -> String {
        let body = ["refreshToken": refreshToken]
        
        do {
            let response = try await post(path: "/auth/refresh", body: body)
            saveTokens(from: response)
            return response.accessToken
        } catch let error as APIError where error.statusCode == 401 {
            // Refresh token expired - user must sign in again
            clearTokens()
            throw AuthError.sessionExpired
        }
    }
}
```

### 4. Sign Out

```swift
extension AuthManager {
    func signOut() async {
        guard let token = accessToken else { return }
        
        do {
            var request = URLRequest(url: URL(string: "\(baseURL)/auth/signout")!)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            
            _ = try await URLSession.shared.data(for: request)
        } catch {
            // Sign out is best-effort - continue even if it fails
            print("Sign out request failed: \(error)")
        }
        
        clearTokens()
    }
}
```

### 5. Making Authenticated Requests

```swift
extension AuthManager {
    func authenticatedRequest(path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> Data {
        let token = try await getValidAccessToken()
        
        var request = URLRequest(url: URL(string: "\(baseURL)\(path)")!)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        
        if let body = body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        
        let (data, response) = try await URLSession.shared.data(for: request)
        
        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        
        if httpResponse.statusCode == 401 {
            // Token might have just expired - try refresh once
            let newToken = try await getValidAccessToken()
            request.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
            let (retryData, _) = try await URLSession.shared.data(for: request)
            return retryData
        }
        
        return data
    }
}
```

### 6. Response Models

```swift
struct AuthResponse: Codable {
    let accessToken: String
    let refreshToken: String
    let expiresIn: Int
    let expiresAt: Int
    let user: AuthUser
}

struct AuthUser: Codable {
    let id: String
    let email: String?
    let createdAt: String
}

enum AuthError: Error {
    case notLoggedIn
    case sessionExpired
    case invalidResponse
}
```

---

## Important Notes

### Apple Sign In Specifics

1. **Name is only sent once**: Apple only provides the user's name on their very first sign-in. The backend stores it automatically, but if you miss it, the user must:
   - Go to Settings → Apple ID → Password & Security → Apps Using Apple ID
   - Remove your app
   - Sign in again

2. **Email may be hidden**: Users can choose to hide their email. In this case, they get a private relay address like `abc123@privaterelay.appleid.com`

3. **Identity token expiration**: Apple's identity token is short-lived (~10 minutes). Send it to the backend immediately after receiving it.

### Token Lifecycle

| Token | Lifetime | Storage | When to Refresh |
|-------|----------|---------|-----------------|
| Access Token | ~1 hour | Keychain | When expired or about to expire (5 min buffer) |
| Refresh Token | ~30 days | Keychain | Automatically rotated on each refresh |

### Session Persistence

Users stay logged in as long as:
- They use the app within the refresh token validity period (~30 days)
- They don't explicitly sign out
- Their account isn't revoked

---

## Error Handling

All error responses follow this format:

```json
{
  "error": "Human-readable error message",
  "code": "ERROR_CODE"
}
```

### Common Error Codes

| Code | Meaning | Action |
|------|---------|--------|
| `INVALID_PROVIDER` | Wrong provider value | Use "apple" or "google" |
| `MISSING_TOKEN` | No idToken provided | Include identity token |
| `AUTH_FAILED` | Invalid identity token | Token expired or invalid - retry sign in |
| `INVALID_REFRESH_TOKEN` | Refresh token expired | User must sign in again |
| `MISSING_REFRESH_TOKEN` | No refresh token | Include refresh token |



