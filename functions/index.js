const { logger } = require("firebase-functions");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const twilio = require("twilio");

admin.initializeApp();

const MAIL_COLLECTION = process.env.MAIL_COLLECTION || "mail";
const DEFAULT_TEACHER_EMAILS = [
  "dgonzalezjr@crossroadsschoolskc.org",
  "lvest@crossroadsschoolskc.org",
];
const DEFAULT_TEACHER_PHONE_NUMBERS = [
  "+18164821708",
];
const EMAIL_TO_SMS_RECIPIENTS = isEnabled(process.env.ENABLE_EMAIL_TO_SMS_GATEWAYS)
  ? parseEmailRecipientList(process.env.TEACHER_NOTIFICATION_SMS_EMAILS)
  : [];
const NOTIFICATION_RECIPIENTS = uniqueRecipients([
  ...DEFAULT_TEACHER_EMAILS,
  ...parseEmailRecipientList(process.env.TEACHER_NOTIFICATION_EMAIL),
  ...parseEmailRecipientList(process.env.TEACHER_NOTIFICATION_EMAILS),
  ...EMAIL_TO_SMS_RECIPIENTS,
]);
const SMS_RECIPIENTS = uniqueRecipients([
  ...DEFAULT_TEACHER_PHONE_NUMBERS,
  ...parseList(process.env.TEACHER_NOTIFICATION_PHONE_NUMBERS),
]);

exports.queueTeacherActivityEmail = onDocumentCreated("teacherActivity/{activityId}", async (event) => {
  const snapshot = event.data;
  if (!snapshot) {
    logger.warn("Teacher activity email skipped because the activity snapshot was missing.", {
      activityId: event.params.activityId,
    });
    return;
  }

  const activity = snapshot.data() || {};
  const email = buildActivityEmail(activity, event.params.activityId);

  await admin.firestore().collection(MAIL_COLLECTION).add(email);
  await sendTeacherActivitySms(activity, event.params.activityId);

  logger.info("Queued teacher activity email.", {
    activityId: event.params.activityId,
    activityType: activity.type || "activity",
    mailCollection: MAIL_COLLECTION,
    recipientCount: NOTIFICATION_RECIPIENTS.length,
    smsRecipientCount: getTwilioConfig() ? SMS_RECIPIENTS.length : 0,
  });
});

function buildActivityEmail(activity, activityId) {
  const title = asText(activity.title) || labelForType(activity.type);
  const details = asText(activity.details) || "A parent activity was recorded on the First Grade Hub.";
  const page = asText(activity.page) || "First Grade Hub";
  const createdAt = readableDate(activity.createdAt) || asText(activity.createdAtLocal) || "Time not provided";
  const activityType = asText(activity.type) || "activity";

  const subject = `First Grade Hub: ${title}`;
  const text = [
    details,
    "",
    `Page: ${page}`,
    `Type: ${activityType}`,
    `Time: ${createdAt}`,
    `Activity ID: ${activityId}`,
  ].join("\n");

  const html = `
    <p>${escapeHtml(details)}</p>
    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;">
      <tr><td><strong>Page</strong></td><td>${escapeHtml(page)}</td></tr>
      <tr><td><strong>Type</strong></td><td>${escapeHtml(activityType)}</td></tr>
      <tr><td><strong>Time</strong></td><td>${escapeHtml(createdAt)}</td></tr>
      <tr><td><strong>Activity ID</strong></td><td>${escapeHtml(activityId)}</td></tr>
    </table>
  `;

  return {
    to: NOTIFICATION_RECIPIENTS,
    message: {
      subject,
      text,
      html,
    },
  };
}

async function sendTeacherActivitySms(activity, activityId) {
  const config = getTwilioConfig();
  if (!config || !SMS_RECIPIENTS.length) return;

  const client = twilio(config.accountSid, config.authToken);
  const body = buildActivitySms(activity, activityId);

  try {
    await Promise.all(SMS_RECIPIENTS.map((to) => client.messages.create({
      body,
      from: config.fromNumber,
      to,
    })));

    logger.info("Sent teacher activity SMS.", {
      activityId,
      activityType: activity.type || "activity",
      smsRecipientCount: SMS_RECIPIENTS.length,
    });
  } catch (error) {
    logger.warn("Teacher activity SMS failed.", {
      activityId,
      activityType: activity.type || "activity",
      message: error && error.message ? error.message : String(error),
    });
  }
}

function buildActivitySms(activity, activityId) {
  const title = asText(activity.title) || labelForType(activity.type);
  const details = asText(activity.details) || "A parent activity was recorded on the First Grade Hub.";
  return truncateSmsBody(`First Grade Hub: ${title}\n${details}\nID: ${activityId}`);
}

function truncateSmsBody(value) {
  const text = asText(value);
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

function getTwilioConfig() {
  const accountSid = asText(process.env.TWILIO_ACCOUNT_SID);
  const authToken = asText(process.env.TWILIO_AUTH_TOKEN);
  const fromNumber = asText(process.env.TWILIO_FROM_NUMBER);

  if (!accountSid || !authToken || !fromNumber) return null;
  return { accountSid, authToken, fromNumber };
}

function parseList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((recipient) => recipient.trim())
    .filter(Boolean);
}

function parseEmailRecipientList(value) {
  return parseList(value).map((recipient) => recipient.toLowerCase());
}

function uniqueRecipients(recipients) {
  return Array.from(new Set(recipients.filter(Boolean)));
}

function isEnabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function labelForType(type) {
  switch (type) {
    case "snack":
      return "Snack signup updated";
    case "shoutout":
      return "New student shoutout";
    case "volunteer":
      return "Volunteer signup updated";
    case "transportation":
      return "Transportation note updated";
    default:
      return "New parent activity";
  }
}

function readableDate(value) {
  if (!value) return "";

  if (typeof value.toDate === "function") {
    return value.toDate().toLocaleString("en-US", { timeZone: "America/Chicago" });
  }

  if (typeof value === "string") {
    return value;
  }

  return "";
}

function asText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function escapeHtml(value) {
  return asText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
