const { logger } = require("firebase-functions");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const MAIL_COLLECTION = process.env.MAIL_COLLECTION || "mail";
const APPROVED_EDITOR_EMAILS = new Set([
  "davisg230@gmail.com",
  "lvest@crossroadsschoolskc.org",
]);
const DEFAULT_TEACHER_EMAILS = [
  "dgonzalezjr@crossroadsschoolskc.org",
  "lvest@crossroadsschoolskc.org",
];
const NOTIFICATION_RECIPIENTS = uniqueRecipients([
  ...DEFAULT_TEACHER_EMAILS,
  ...parseRecipientList(process.env.TEACHER_NOTIFICATION_EMAIL),
  ...parseRecipientList(process.env.TEACHER_NOTIFICATION_EMAILS),
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

  logger.info("Queued teacher activity email.", {
    activityId: event.params.activityId,
    activityType: activity.type || "activity",
    mailCollection: MAIL_COLLECTION,
    recipientCount: NOTIFICATION_RECIPIENTS.length,
  });
});

exports.analyzeCurriculumLesson = onCall(
  {
    secrets: [OPENAI_API_KEY],
    timeoutSeconds: 120,
    memory: "512MiB",
  },
  async (request) => {
    const email = asText(request.auth && request.auth.token && request.auth.token.email).toLowerCase();
    if (!APPROVED_EDITOR_EMAILS.has(email)) {
      throw new HttpsError("permission-denied", "Teacher sign-in is required to analyze curriculum lessons.");
    }

    const data = request.data || {};
    const sourceText = asText(data.sourceText);
    if (sourceText.length < 40) {
      throw new HttpsError("invalid-argument", "Paste one full lesson before running the AI analyzer.");
    }
    if (sourceText.length > 20000) {
      throw new HttpsError("invalid-argument", "Paste one lesson at a time so the AI request stays focused and low-cost.");
    }

    const apiKey = OPENAI_API_KEY.value();
    if (!apiKey) {
      throw new HttpsError("failed-precondition", "The OpenAI API key is not configured yet.");
    }

    const model = process.env.OPENAI_MODEL || "gpt-5.6-luna";
    const prompt = buildCurriculumAnalysisPrompt({
      subject: asText(data.subject),
      unitOrModule: asText(data.unitOrModule),
      lessonNumber: asText(data.lessonNumber),
      lessonTitle: asText(data.lessonTitle),
      sourceText,
    });

    let response;
    try {
      response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          instructions: [
            "You are a careful first grade curriculum assistant.",
            "Extract only what is supported by the provided lesson source.",
            "Do not invent standards, objectives, video links, vocabulary, or materials.",
            "If a field is not present, leave it empty and add a short note to missingInformation.",
            "Write parent-facing language clearly and warmly for families.",
          ].join(" "),
          input: prompt,
          max_output_tokens: 2200,
          text: {
            format: {
              type: "json_schema",
              name: "curriculum_lesson_analysis",
              strict: true,
              schema: CURRICULUM_LESSON_SCHEMA,
            },
          },
        }),
      });
    } catch (error) {
      logger.error("OpenAI curriculum request failed before response.", { message: error.message });
      throw new HttpsError("unavailable", "The AI service could not be reached. Please try again.");
    }

    const responseBody = await readJsonResponse(response);
    if (!response.ok) {
      logger.error("OpenAI curriculum request failed.", {
        status: response.status,
        message: responseBody && responseBody.error && responseBody.error.message,
      });
      throw new HttpsError("internal", "The AI analyzer returned an error. Please try again.");
    }

    const outputText = extractOpenAIOutputText(responseBody);
    if (!outputText) {
      logger.error("OpenAI curriculum response had no output text.", { responseId: responseBody && responseBody.id });
      throw new HttpsError("internal", "The AI analyzer did not return a usable draft.");
    }

    let analysis;
    try {
      analysis = JSON.parse(outputText);
    } catch (error) {
      logger.error("OpenAI curriculum response was not valid JSON.", { message: error.message });
      throw new HttpsError("internal", "The AI analyzer returned a draft in the wrong format.");
    }

    return {
      analysis: normalizeCurriculumAnalysis(analysis),
      analyzedAt: new Date().toISOString(),
      model,
    };
  }
);

const CURRICULUM_LESSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    subject: { type: "string", enum: ["skills", "listening", "math", "other"] },
    unitOrModule: { type: "string" },
    lessonNumber: { type: "string" },
    lessonTitle: { type: "string" },
    iCanStatement: { type: "string" },
    priorityStandard: { type: "string" },
    objective: { type: "string" },
    vocabulary: { type: "array", items: { type: "string" } },
    materials: { type: "array", items: { type: "string" } },
    videoLinks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          note: { type: "string" },
        },
        required: ["title", "url", "note"],
      },
    },
    parentSummary: { type: "string" },
    familyQuestions: { type: "array", items: { type: "string" } },
    teacherNotes: { type: "array", items: { type: "string" } },
    missingInformation: { type: "array", items: { type: "string" } },
    sourceConfidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: [
    "subject",
    "unitOrModule",
    "lessonNumber",
    "lessonTitle",
    "iCanStatement",
    "priorityStandard",
    "objective",
    "vocabulary",
    "materials",
    "videoLinks",
    "parentSummary",
    "familyQuestions",
    "teacherNotes",
    "missingInformation",
    "sourceConfidence",
  ],
};

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

function parseRecipientList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((recipient) => recipient.trim().toLowerCase())
    .filter(Boolean);
}

function uniqueRecipients(recipients) {
  return Array.from(new Set(recipients.filter(Boolean)));
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

function buildCurriculumAnalysisPrompt(data) {
  return [
    "Analyze this first grade curriculum lesson for a teacher-facing lesson library.",
    "",
    `Subject selected by teacher: ${data.subject || "not provided"}`,
    `Unit/module selected by teacher: ${data.unitOrModule || "not provided"}`,
    `Lesson number selected by teacher: ${data.lessonNumber || "not provided"}`,
    `Lesson title selected by teacher: ${data.lessonTitle || "not provided"}`,
    "",
    "Return the exact structured fields requested by the schema.",
    "For the I can statement, write one student-friendly sentence starting with \"I can\" when possible.",
    "For parentSummary, explain the lesson in 1-2 short family-friendly sentences without curriculum jargon.",
    "For videoLinks, extract only real URLs from the lesson source. If there are no URLs, return an empty array and note that in missingInformation.",
    "For missingInformation, list any important fields that were not found in the source.",
    "",
    "Lesson source:",
    data.sourceText,
  ].join("\n");
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    return { raw: text };
  }
}

function extractOpenAIOutputText(responseBody) {
  if (!responseBody) return "";
  if (typeof responseBody.output_text === "string") return responseBody.output_text.trim();
  if (!Array.isArray(responseBody.output)) return "";
  const parts = [];
  responseBody.output.forEach((item) => {
    if (!item || !Array.isArray(item.content)) return;
    item.content.forEach((content) => {
      if (content && typeof content.text === "string") parts.push(content.text);
      if (content && typeof content.output_text === "string") parts.push(content.output_text);
    });
  });
  return parts.join("\n").trim();
}

function normalizeCurriculumAnalysis(analysis) {
  return {
    subject: ["skills", "listening", "math", "other"].includes(analysis.subject) ? analysis.subject : "other",
    unitOrModule: asText(analysis.unitOrModule),
    lessonNumber: asText(analysis.lessonNumber),
    lessonTitle: asText(analysis.lessonTitle),
    iCanStatement: asText(analysis.iCanStatement),
    priorityStandard: asText(analysis.priorityStandard),
    objective: asText(analysis.objective),
    vocabulary: normalizeStringArray(analysis.vocabulary),
    materials: normalizeStringArray(analysis.materials),
    videoLinks: normalizeVideoLinks(analysis.videoLinks),
    parentSummary: asText(analysis.parentSummary),
    familyQuestions: normalizeStringArray(analysis.familyQuestions),
    teacherNotes: normalizeStringArray(analysis.teacherNotes),
    missingInformation: normalizeStringArray(analysis.missingInformation),
    sourceConfidence: ["high", "medium", "low"].includes(analysis.sourceConfidence) ? analysis.sourceConfidence : "medium",
  };
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asText(item)).filter(Boolean);
}

function normalizeVideoLinks(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    title: asText(item && item.title) || "Video",
    url: asText(item && item.url),
    note: asText(item && item.note),
  })).filter((item) => item.title || item.url || item.note);
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
