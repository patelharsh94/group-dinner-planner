import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const randomToken = () => randomBytes(24).toString("base64url");
export const tokenHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function secretMatches(
  expected: string,
  actual: string | undefined,
): boolean {
  if (!actual) return false;
  const a = Buffer.from(expected),
    b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function encrypt(value: unknown, key: string, context: string): string {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), nonce);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [nonce, cipher.getAuthTag(), encrypted]
    .map((v) => v.toString("base64url"))
    .join(".");
}
export function decrypt(value: string, key: string, context: string): unknown {
  const parts = value.split(".");
  if (parts.length !== 3) throw new Error("Invalid encrypted credential");
  const [nonce, tag, data] = parts.map((v) => Buffer.from(v, "base64url"));
  const cipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key, "base64"),
    nonce,
  );
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([cipher.update(data), cipher.final()]).toString("utf8"),
  );
}
