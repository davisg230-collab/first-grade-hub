const { logger } = require("firebase-functions");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");

admin.initializeApp();

const MAIL_COLLECTION = process.env.MAIL_COLLECTION || "mail";
const TEACHER_EMAIL = process.env.TEACHER_NOTIFICATION_EMAIL || "dgonzalezjr@crossroadsschoolskc.org";

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

  logger.info("Queued teacher activity email.", {
    activityId: event.params.activityId,
    activityType: activity.type || "activity",
    mailCollection: MAIL_COLLECTION,
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
    to: [TEACHER_EMAIL],
    message: {
      subject,
      text,
      html,
    },
  };
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
