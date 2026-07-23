/**
 * ============================================================
 *  Epoch — Private Photo Sharing for Couples
 *  Single AWS Lambda  ·  Node.js 20.x  ·  API Gateway HTTP API
 * ============================================================
 *
 *  Environment Variables (set in Lambda configuration):
 *    JWT_SECRET          – secret key for signing tokens
 *    USERS_TABLE         – DynamoDB table name  (default: epochUsersTable)
 *    PHOTOS_TABLE        – DynamoDB table name  (default: epochPhotosTable)
 *    PHOTOS_BUCKET       – S3 bucket for photos
 *    PHOTO_TTL_HOURS     – photo expiry in hours (default: 24)
 *    PRESIGN_EXPIRY_SECS – presigned-URL lifetime (default: 3600)
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

// ─── Clients ────────────────────────────────────────────────
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});

// ─── Config ─────────────────────────────────────────────────
const USERS_TABLE = process.env.USERS_TABLE || "epochUsersTable";
const PHOTOS_TABLE = process.env.PHOTOS_TABLE || "epochPhotosTable";
const PHOTOS_BUCKET = process.env.PHOTOS_BUCKET || "epoch-images-bucket";
const JWT_SECRET = process.env.JWT_SECRET || "epoch-default-secret-change-me";
const PHOTO_TTL_HOURS = parseInt(process.env.PHOTO_TTL_HOURS || "24", 10);
const PRESIGN_EXPIRY = parseInt(process.env.PRESIGN_EXPIRY_SECS || "3600", 10);
const BCRYPT_SALT_ROUNDS = 7;

// ─── Helpers: HTTP responses ────────────────────────────────
const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
};

const respond = (statusCode, body) => ({
  statusCode,
  headers,
  body: JSON.stringify(body),
});

const ok = (data) => respond(200, data);
const created = (data) => respond(201, data);
const badRequest = (msg) => respond(400, { error: msg });
const unauthorized = (msg = "Unauthorized") => respond(401, { error: msg });
const forbidden = (msg = "Forbidden") => respond(403, { error: msg });
const notFound = (msg = "Not found") => respond(404, { error: msg });
const conflict = (msg) => respond(409, { error: msg });
const serverError = (msg = "Internal server error") => respond(500, { error: msg });

// ─── Helpers: hashing───────────────────
async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
}

async function verifyPassword(password, storedHash) {
  return bcrypt.compare(password, storedHash);
}

// ─── Helpers: JWT────────────────────────────
function signJwt(payload, expiresIn = "10y") {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

function verifyJwt(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// ─── Helpers: Auth extraction ───────────────────────────────
function extractUserId(event) {
  const authHeader =
    event.headers?.authorization || event.headers?.Authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader;
  if (!token) return null;

  const payload = verifyJwt(token);
  return payload?.userId || null;
}

// ─── Helpers: DynamoDB full scan with filter ─────────────────
async function scanForItem(tableName, filterExpression, expressionValues) {
  let lastKey = undefined;
  do {
    const params = {
      TableName: tableName,
      FilterExpression: filterExpression,
      ExpressionAttributeValues: expressionValues,
      ExclusiveStartKey: lastKey,
    };
    const result = await ddb.send(new ScanCommand(params));
    if (result.Items && result.Items.length > 0) {
      return result.Items[0];
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return null;
}

// ─── Helpers: id generator ──────────────────────────────────────────
function generateShareId() {
  return uuidv4().replace(/-/g, "").substring(0, 8).toUpperCase();
}

function parseBody(event) {
  try {
    if (!event.body) return {};
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString()
      : event.body;
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ─── Validation Schemas (zod) ───────────────────────────────
const registerSchema = z.object({
  username: z.string().min(1, "username is required").max(50),
  password: z.string().min(1, "password is required").max(128),
  email: z.string().email("Invalid email format").optional().nullable(),
});

const loginSchema = z.object({
  username: z.string().min(1, "username is required"),
  password: z.string().min(1, "password is required"),
});

const connectSchema = z.object({
  shareId: z.string().min(1, "shareId is required"),
});

const uploadSchema = z.object({
  contentType: z.enum(["image/jpeg", "image/png"]).optional().default("image/jpeg"),
});

// ─── Route: POST /auth/register ─────────────────────────────
async function register(event) {
  const body = parseBody(event);

  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    const firstError = parsed.error.issues[0]?.message || "Invalid input";
    return badRequest(firstError);
  }

  const { username, password, email } = parsed.data;

  // Check for duplicate username (full scan, no Limit)
  const existing = await scanForItem(
    USERS_TABLE,
    "username = :u",
    { ":u": username }
  );
  if (existing) {
    return conflict("Username already taken");
  }

  const userId = uuidv4();
  const now = new Date().toISOString();

  const user = {
    userId,
    username,
    email: email || null,
    passwordHash: await hashPassword(password),
    partnerId: null,
    shareId: generateShareId(),
    createdAt: now,
    lastLogin: now,
    status: "active",
    profileImage: null,
  };

  await ddb.send(new PutCommand({ TableName: USERS_TABLE, Item: user }));

  const token = signJwt({ userId, username });

  return created({
    message: "Registration successful",
    token,
    user: {
      userId: user.userId,
      username: user.username,
      email: user.email,
      shareId: user.shareId,
      createdAt: user.createdAt,
    },
  });
}

// ─── Route: POST /auth/login ────────────────────────────────
async function login(event) {
  const body = parseBody(event);

  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    const firstError = parsed.error.issues[0]?.message || "Invalid input";
    return badRequest(firstError);
  }

  const { username, password } = parsed.data;

  // Find user by username (full scan, no Limit)
  const user = await scanForItem(
    USERS_TABLE,
    "username = :u",
    { ":u": username }
  );

  if (!user) return unauthorized("Invalid credentials");

  const passwordValid = await verifyPassword(password, user.passwordHash);
  if (!passwordValid) {
    return unauthorized("Invalid credentials");
  }

  // Update lastLogin
  await ddb.send(
    new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { userId: user.userId },
      UpdateExpression: "SET lastLogin = :now",
      ExpressionAttributeValues: { ":now": new Date().toISOString() },
    })
  );

  const token = signJwt({ userId: user.userId, username: user.username });

  return ok({
    message: "Login successful",
    token,
    user: {
      userId: user.userId,
      username: user.username,
      email: user.email,
      shareId: user.shareId,
      partnerId: user.partnerId,
    },
  });
}

// ─── Route: GET /users/me ───────────────────────────────────
async function getMe(event) {
  const userId = extractUserId(event);
  if (!userId) return unauthorized();

  const result = await ddb.send(
    new GetCommand({ TableName: USERS_TABLE, Key: { userId } })
  );

  const user = result.Item;
  if (!user) return notFound("User not found");

  return ok({
    userId: user.userId,
    username: user.username,
    email: user.email,
    shareId: user.shareId,
    partnerId: user.partnerId,
    createdAt: user.createdAt,
    lastLogin: user.lastLogin,
    status: user.status,
    profileImage: user.profileImage,
  });
}

// ─── Route: POST /partner/connect ───────────────────────────
async function connectPartner(event) {
  const userId = extractUserId(event);
  if (!userId) return unauthorized();

  const body = parseBody(event);

  const parsed = connectSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest("shareId is required");
  }

  const { shareId } = parsed.data;

  // Find the partner by shareId (full scan, no Limit)
  const partner = await scanForItem(
    USERS_TABLE,
    "shareId = :sid",
    { ":sid": shareId }
  );

  if (!partner) return notFound("No user found with that Share ID");

  if (partner.userId === userId) {
    return badRequest("You cannot connect with yourself");
  }

  // Get current user
  const meResult = await ddb.send(
    new GetCommand({ TableName: USERS_TABLE, Key: { userId } })
  );
  const me = meResult.Item;
  if (!me) return notFound("User not found");

  if (me.partnerId) {
    return conflict("You are already connected to a partner. Disconnect first.");
  }
  if (partner.partnerId) {
    return conflict("That user is already connected to someone else");
  }

  // Link both users
  await Promise.all([
    ddb.send(
      new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { userId },
        UpdateExpression: "SET partnerId = :pid",
        ExpressionAttributeValues: { ":pid": partner.userId },
      })
    ),
    ddb.send(
      new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { userId: partner.userId },
        UpdateExpression: "SET partnerId = :pid",
        ExpressionAttributeValues: { ":pid": userId },
      })
    ),
  ]);

  return ok({
    message: "Partner connected successfully",
    partnerId: partner.userId,
    partnerUsername: partner.username,
  });
}

// ─── Route: DELETE /partner ─────────────────────────────────
async function disconnectPartner(event) {
  const userId = extractUserId(event);
  if (!userId) return unauthorized();

  const meResult = await ddb.send(
    new GetCommand({ TableName: USERS_TABLE, Key: { userId } })
  );
  const me = meResult.Item;
  if (!me) return notFound("User not found");

  if (!me.partnerId) return badRequest("You are not connected to a partner");

  const partnerId = me.partnerId;

  // Unlink both users
  await Promise.all([
    ddb.send(
      new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { userId },
        UpdateExpression: "SET partnerId = :null",
        ExpressionAttributeValues: { ":null": null },
      })
    ),
    ddb.send(
      new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { userId: partnerId },
        UpdateExpression: "SET partnerId = :null",
        ExpressionAttributeValues: { ":null": null },
      })
    ),
  ]);

  return ok({ message: "Partner disconnected successfully" });
}

// ─── Route: GET /partner ────────────────────────────────────
async function getPartner(event) {
  const userId = extractUserId(event);
  if (!userId) return unauthorized();

  const meResult = await ddb.send(
    new GetCommand({ TableName: USERS_TABLE, Key: { userId } })
  );
  const me = meResult.Item;
  if (!me) return notFound("User not found");

  if (!me.partnerId) return ok({ partner: null });

  const partnerResult = await ddb.send(
    new GetCommand({ TableName: USERS_TABLE, Key: { userId: me.partnerId } })
  );
  const partner = partnerResult.Item;
  if (!partner) return ok({ partner: null });

  return ok({
    partner: {
      userId: partner.userId,
      username: partner.username,
      profileImage: partner.profileImage,
      status: partner.status,
    },
  });
}

// ─── Route: POST /photos/upload ─────────────────────────────
async function uploadPhoto(event) {
  const userId = extractUserId(event);
  if (!userId) return unauthorized();

  // Get current user to find partner
  const meResult = await ddb.send(
    new GetCommand({ TableName: USERS_TABLE, Key: { userId } })
  );
  const me = meResult.Item;
  if (!me) return notFound("User not found");

  if (!me.partnerId) {
    return badRequest("You must be connected to a partner before uploading photos");
  }

  const body = parseBody(event);
  const parsed = uploadSchema.safeParse(body);
  const contentType = parsed.success ? parsed.data.contentType : "image/jpeg";

  const photoId = uuidv4();
  const extension = contentType === "image/png" ? "png" : "jpg";
  const s3Key = `photos/${userId}/${photoId}.${extension}`;

  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = Math.floor(now.getTime() / 1000) + PHOTO_TTL_HOURS * 3600;

  // Generate presigned PUT URL for the client to upload directly to S3
  const putCommand = new PutObjectCommand({
    Bucket: PHOTOS_BUCKET,
    Key: s3Key,
    ContentType: contentType,
  });
  const uploadUrl = await getSignedUrl(s3, putCommand, {
    expiresIn: PRESIGN_EXPIRY,
  });

  // Save photo metadata
  const photoRecord = {
    photoId,
    senderId: userId,
    receiverId: me.partnerId,
    s3Key,
    createdAt,
    expiresAt,
  };

  await ddb.send(
    new PutCommand({ TableName: PHOTOS_TABLE, Item: photoRecord })
  );

  return created({
    message: "Photo record created. Upload the image to the presigned URL.",
    photoId,
    uploadUrl,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  });
}

// ─── Route: GET /photos/latest ──────────────────────────────
async function getLatestPhoto(event) {
  const userId = extractUserId(event);
  if (!userId) return unauthorized();

  // Query the photos table for photos sent TO this user, newest first
  const result = await ddb.send(
    new QueryCommand({
      TableName: PHOTOS_TABLE,
      KeyConditionExpression: "receiverId = :rid",
      ExpressionAttributeValues: { ":rid": userId },
      ScanIndexForward: false, // descending by createdAt
      Limit: 1,
    })
  );

  const photo = result.Items?.[0];
  if (!photo) return ok({ photo: null, message: "No photos available" });

  // Check if the photo has expired (belt-and-suspenders alongside DynamoDB TTL)
  const nowEpoch = Math.floor(Date.now() / 1000);
  if (photo.expiresAt && photo.expiresAt <= nowEpoch) {
    return ok({ photo: null, message: "No photos available" });
  }

  // Generate presigned GET URL so the client can download the image
  const getCommand = new GetObjectCommand({
    Bucket: PHOTOS_BUCKET,
    Key: photo.s3Key,
  });
  const downloadUrl = await getSignedUrl(s3, getCommand, {
    expiresIn: PRESIGN_EXPIRY,
  });

  return ok({
    photo: {
      photoId: photo.photoId,
      senderId: photo.senderId,
      createdAt: photo.createdAt,
      expiresAt: new Date(photo.expiresAt * 1000).toISOString(),
      url: downloadUrl,
    },
  });
}

// ─── Router ─────────────────────────────────────────────────
function resolveRoute(event) {
  const method = (
    event.requestContext?.http?.method ||
    event.httpMethod ||
    ""
  ).toUpperCase();

  const rawPath =
    event.rawPath ||
    event.requestContext?.http?.path ||
    event.path ||
    "";

  // Strip stage prefix
  const path = rawPath.replace(/^\/[^/]+(?=\/auth|\/users|\/partner|\/photos)/, "");

  return { method, path };
}

// ─── Handler ────────────────────────────────────────────────
export const handler = async (event) => {
  try {
    if (
      (event.requestContext?.http?.method || event.httpMethod) === "OPTIONS"
    ) {
      return respond(200, {});
    }

    const { method, path } = resolveRoute(event);

    // ── Auth ──
    if (method === "POST" && path === "/auth/register") return await register(event);
    if (method === "POST" && path === "/auth/login") return await login(event);

    // ── User ──
    if (method === "GET" && path === "/users/me") return await getMe(event);

    // ── Partner ──
    if (method === "POST" && path === "/partner/connect") return await connectPartner(event);
    if (method === "DELETE" && path === "/partner") return await disconnectPartner(event);
    if (method === "GET" && path === "/partner") return await getPartner(event);

    // ── Photos ──
    if (method === "POST" && path === "/photos/upload") return await uploadPhoto(event);
    if (method === "GET" && path === "/photos/latest") return await getLatestPhoto(event);

    return notFound(`No route for ${method} ${path}`);
  } catch (err) {
    console.error("Unhandled error:", err);
    return serverError("Internal server error");
  }
};
