import crypto from "node:crypto";
import QRCode from "qrcode";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SESClient, SendRawEmailCommand } from "@aws-sdk/client-ses";

const { TABLE, SECRET, VOLUNTEER_PIN, FROM_EMAIL, EVENT_NAME } = process.env;
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ses = new SESClient({});

const json = (code, body) => ({
  statusCode: code,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const sign = (id) =>
  crypto.createHmac("sha256", SECRET).update(id).digest("hex").slice(0, 24);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const handler = async (event) => {
  try {
    const path = event.rawPath || "";
    const body = JSON.parse(event.body || "{}");
    if (path.endsWith("/register")) return await register(body);
    if (path.endsWith("/checkin")) return await checkin(body, event.headers || {});
    return json(404, { ok: false, reason: "Not found" });
  } catch (e) {
    console.error(e);
    return json(500, { ok: false, reason: "Server error, please try again" });
  }
};

async function register(b) {
  const name = String(b.name || "").trim().slice(0, 100);
  const email = String(b.email || "").trim().toLowerCase().slice(0, 200);
  const roll = String(b.roll || "").trim().slice(0, 50);
  if (!name || !roll || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return json(400, { ok: false, reason: "Please fill all fields correctly" });

  // One ticket per email: ID is derived from the email address
  const ticketId = crypto.createHash("sha256").update(email).digest("hex").slice(0, 16);
  let finalName = name;
  try {
    await db.send(new PutCommand({
      TableName: TABLE,
      Item: { ticketId, name, email, roll, createdAt: new Date().toISOString() },
      ConditionExpression: "attribute_not_exists(ticketId)",
    }));
  } catch (e) {
    if (e.name !== "ConditionalCheckFailedException") throw e;
    // Already registered: resend the same ticket
    const g = await db.send(new GetCommand({ TableName: TABLE, Key: { ticketId } }));
    finalName = g.Item.name;
  }
  await sendTicket(email, finalName, `${ticketId}.${sign(ticketId)}`);
  return json(200, { ok: true });
}

async function sendTicket(to, name, qrText) {
  const png = await QRCode.toBuffer(qrText, { width: 300, margin: 2 });
  const b = "BOUNDARY_" + crypto.randomBytes(8).toString("hex");
  const html = `<div style="font-family:sans-serif;text-align:center">
<h2>${esc(EVENT_NAME || "Event")} - Your Ticket</h2>
<p>Hi ${esc(name)}, show this QR code at the entrance.</p>
<img src="cid:qr" width="300" height="300" alt="QR ticket"></div>`;
  const wrap = (s) => s.match(/.{1,76}/g).join("\r\n");
  const raw = [
    `From: ${FROM_EMAIL}`,
    `To: ${to}`,
    `Subject: Your ticket for ${(EVENT_NAME || "the event").replace(/[^\x20-\x7E]/g, "")}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/related; boundary="${b}"`,
    "",
    `--${b}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap(Buffer.from(html).toString("base64")),
    `--${b}`,
    'Content-Type: image/png; name="ticket.png"',
    "Content-Transfer-Encoding: base64",
    "Content-ID: <qr>",
    'Content-Disposition: inline; filename="ticket.png"',
    "",
    wrap(png.toString("base64")),
    `--${b}--`,
    "",
  ].join("\r\n");
  await ses.send(new SendRawEmailCommand({ RawMessage: { Data: Buffer.from(raw) } }));
}

async function checkin(b, headers) {
  if (headers["x-volunteer-pin"] !== VOLUNTEER_PIN)
    return json(401, { ok: false, reason: "Wrong volunteer PIN" });

  const [id, sig] = String(b.qr || "").split(".");
  const good = Buffer.from(id ? sign(id) : "x");
  const given = Buffer.from(sig || "");
  if (!id || !sig || good.length !== given.length || !crypto.timingSafeEqual(good, given))
    return json(400, { ok: false, reason: "Fake or damaged QR code" });

  try {
    const r = await db.send(new UpdateCommand({
      TableName: TABLE,
      Key: { ticketId: id },
      UpdateExpression: "SET checkedInAt = :t",
      ConditionExpression: "attribute_exists(ticketId) AND attribute_not_exists(checkedInAt)",
      ExpressionAttributeValues: { ":t": new Date().toISOString() },
      ReturnValues: "ALL_NEW",
    }));
    return json(200, { ok: true, name: r.Attributes.name });
  } catch (e) {
    if (e.name !== "ConditionalCheckFailedException") throw e;
    const g = await db.send(new GetCommand({ TableName: TABLE, Key: { ticketId: id } }));
    if (!g.Item) return json(404, { ok: false, reason: "Ticket not found" });
    return json(409, { ok: false, name: g.Item.name, reason: "Already used at " + g.Item.checkedInAt });
  }
}