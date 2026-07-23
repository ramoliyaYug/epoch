# Epoch API Documentation

> **Base URL:** `https://w8rbao25mh.execute-api.ap-south-1.amazonaws.com/dev`

---

## Table of Contents


1. [Authentication](#1-authentication)
   - [Register](#11-register)
   - [Login](#12-login)
2. [User](#2-user)
   - [Get My Profile](#21-get-my-profile)
3. [Partner](#3-partner)
   - [Connect Partner](#31-connect-partner)
   - [Get Partner](#32-get-partner)
   - [Disconnect Partner](#33-disconnect-partner)
4. [Photos](#4-photos)
   - [Upload Photo](#41-upload-photo)
   - [Get Latest Photo](#42-get-latest-photo)

---

## 1. Authentication

### 1.1 Register

Register **User A** (the first user of the couple).

```
POST {{baseUrl}}/auth/register
```

**Headers:**

| Key            | Value              |
| -------------- | ------------------ |
| `Content-Type` | `application/json` |

**Body** (raw JSON):

```json
{
  "username": "alice",
  "password": "SecurePass123!",
  "email": "alice@example.com"
}
```

> **Validation Rules:**
> - `username` — required, 1–50 characters
> - `password` — required, 1–128 characters
> - `email` — optional, must be valid email format if provided

**Expected Response** `201 Created`:

```json
{
  "message": "Registration successful",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "userId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "username": "alice",
    "email": "alice@example.com",
    "shareId": "3FA8B1C2",
    "createdAt": "2026-07-23T11:30:00.000Z"
  }
}
```

---

### 1.2 Login

```
POST {{baseUrl}}/auth/login
```

**Headers:**

| Key            | Value              |
| -------------- | ------------------ |
| `Content-Type` | `application/json` |

**Body** (raw JSON):

```json
{
  "username": "alice",
  "password": "SecurePass123!"
}
```

**Expected Response** `200 OK`:

```json
{
  "message": "Login successful",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "userId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "username": "alice",
    "email": "alice@example.com",
    "shareId": "3FA8B1C2",
    "partnerId": null
  }
}
```

---

## 2. User

### 2.1 Get My Profile

```
GET {{baseUrl}}/users/me
```

**Headers:**

| Key              | Value               |
| ---------------- | ------------------- |
| `Authorization`  | `Bearer {{tokenA}}` |

**Body:** _None_

**Expected Response** `200 OK`:

```json
{
  "userId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "username": "alice",
  "email": "alice@example.com",
  "shareId": "3FA8B1C2",
  "partnerId": null,
  "createdAt": "2026-07-23T11:30:00.000Z",
  "lastLogin": "2026-07-23T11:35:00.000Z",
  "status": "active",
  "profileImage": null
}
```

---

## 3. Partner

### 3.1 Connect Partner

User A connects to User B using **User B's Share ID**.

```
POST {{baseUrl}}/partner/connect
```

**Headers:**

| Key              | Value               |
| ---------------- | ------------------- |
| `Content-Type`   | `application/json`  |
| `Authorization`  | `Bearer {{tokenA}}` |

**Body** (raw JSON):

```json
{
  "shareId": "{{shareIdB}}"
}
```

**Expected Response** `200 OK`:

```json
{
  "message": "Partner connected successfully",
  "partnerId": "f9e8d7c6-b5a4-3210-fedc-ba0987654321",
  "partnerUsername": "bob"
}
```

> [!IMPORTANT]
> This is a **bidirectional** operation. After this call, both User A and User B will have each other set as their `partnerId`.

---

### 3.2 Get Partner

```
GET {{baseUrl}}/partner
```

**Headers:**

| Key              | Value               |
| ---------------- | ------------------- |
| `Authorization`  | `Bearer {{tokenA}}` |

**Body:** _None_

**Expected Response** `200 OK` (when connected):

```json
{
  "partner": {
    "userId": "f9e8d7c6-b5a4-3210-fedc-ba0987654321",
    "username": "bob",
    "profileImage": null,
    "status": "active"
  }
}
```

**Expected Response** `200 OK` (when not connected):

```json
{
  "partner": null
}
```

---

### 3.3 Disconnect Partner

```
DELETE {{baseUrl}}/partner
```

**Headers:**

| Key              | Value               |
| ---------------- | ------------------- |
| `Authorization`  | `Bearer {{tokenA}}` |

**Body:** _None_

**Expected Response** `200 OK`:

```json
{
  "message": "Partner disconnected successfully"
}
```

> [!WARNING]
> This removes the partner link for **both** users. After disconnection, neither user will be able to send or receive photos until they reconnect.

---

## 4. Photos

### 4.1 Upload Photo

This is a **two-step process**:

1. **Step 1** — Call the API to create the photo record and get a presigned S3 upload URL.
2. **Step 2** — `PUT` the actual image binary to the presigned URL.

#### Step 1: Create Photo Record

```
POST {{baseUrl}}/photos/upload
```

**Headers:**

| Key              | Value               |
| ---------------- | ------------------- |
| `Content-Type`   | `application/json`  |
| `Authorization`  | `Bearer {{tokenA}}` |

**Body** (raw JSON):

```json
{
  "contentType": "image/jpeg"
}
```

> Supported values: `image/jpeg`, `image/png`

**Expected Response** `201 Created`:

```json
{
  "message": "Photo record created. Upload the image to the presigned URL.",
  "photoId": "c1d2e3f4-a5b6-7890-cdef-1234567890ab",
  "uploadUrl": "https://epoch-photos-bucket.s3.ap-south-1.amazonaws.com/photos/a1b2c3d4.../c1d2e3f4...jpg?X-Amz-Algorithm=...",
  "expiresAt": "2026-07-24T11:30:00.000Z"
}
```

---

#### Step 2: Upload the Image to S3

Create a **new Postman request**:

```
PUT {{uploadUrl}}
```

**Headers:**

| Key              | Value        |
| ---------------- | ------------ |
| `Content-Type`   | `image/jpeg` |

> [!IMPORTANT]
> Do **NOT** include the `Authorization` header for this request.

**Body:**

1. Select **Body** → **binary**
2. Click **Select File** and choose a `.jpg` image from your computer

**Expected Response** `200 OK`:

The response body will be empty. A `200` status means the upload was successful.

---

### 4.2 Get Latest Photo

This is the endpoint the Android widget's **Refresh** button calls.

```
GET {{baseUrl}}/photos/latest
```

**Headers:**

| Key              | Value               |
| ---------------- | ------------------- |
| `Authorization`  | `Bearer {{tokenB}}` |

> [!NOTE]
> Use **User B's token** here. User A uploaded the photo, so User B is the receiver.

**Body:** _None_

**Expected Response** `200 OK` (photo available):

```json
{
  "photo": {
    "photoId": "c1d2e3f4-a5b6-7890-cdef-1234567890ab",
    "senderId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "createdAt": "2026-07-23T11:30:00.000Z",
    "expiresAt": "2026-07-24T11:30:00.000Z",
    "url": "https://epoch-photos-bucket.s3.ap-south-1.amazonaws.com/photos/...?X-Amz-Algorithm=..."
  }
}
```

**Expected Response** `200 OK` (no photo available):

```json
{
  "photo": null,
  "message": "No photos available"
}
```

---
