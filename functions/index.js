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
            "Use the provided lesson source as evidence, but create teacher-useful planning fields when the lesson implies them.",
            "Do not make up lesson facts, materials, URLs, or official standard codes that are not supported by the source.",
            "The I can statement, priority standard focus, vocabulary, parent summary, family questions, and teacher notes are expected to be inferred or written from the lesson when possible.",
            "Leave videoLinks empty unless explicit URLs are present in the lesson source.",
            "Do not mark a field missing only because the lesson did not label it explicitly.",
            "Only add missingInformation when the source is too incomplete to make a responsible teacher draft, except do not mark missing video links.",
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
      const openAiError = responseBody && responseBody.error ? responseBody.error : {};
      logger.error("OpenAI curriculum request failed.", {
        status: response.status,
        code: openAiError.code,
        type: openAiError.type,
        param: openAiError.param,
        message: openAiError.message,
      });
      throw new HttpsError("failed-precondition", getOpenAICurriculumFailureMessage(response.status, responseBody));
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
    "For lessonTitle, use the printed lesson title when it is clear and useful. If it looks like a file name, guide name, or internal curriculum label, ignore it and create a short family-friendly title from the lesson's main learning focus or priority standard, such as \"Sounds p, k, g, n, a\".",
    "For priorityStandard, identify the one main standard focus for the lesson, or two if the lesson genuinely has two equal main goals. Prefer standards listed in the source, choosing the one or two that best match the lesson's main teaching point. If the source provides no standard codes, write the main standard skill in plain language instead of inventing a code.",
    "For the I can statement, create one student-friendly sentence starting with \"I can\" by turning the lesson objective or main teaching goal into kid language. It does not need to appear word-for-word in the source.",
    "For vocabulary, choose lesson words, teaching terms, or curriculum words that students or families may need explained, even if the lesson does not provide a labeled vocabulary list.",
    "For parentSummary, explain the lesson in 1-2 short family-friendly sentences without curriculum jargon.",
    "For familyQuestions, create 2-3 simple questions families could ask at home based on the lesson, even if the source does not include family questions.",
    "For teacherNotes, include practical teaching notes or watch-fors that are directly grounded in the lesson.",
    "For videoLinks, return an empty array unless the source includes explicit URLs. The teacher can add lesson video links manually later.",
    "For missingInformation, do not list missing I can statements, missing priority labels, missing vocabulary lists, or missing family questions just because those labels are not printed in the source. Only list information that is truly needed but unavailable, such as a missing lesson objective, unreadable lesson text, or a missing standards list when no standard focus can be responsibly identified.",
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

function getOpenAICurriculumFailureMessage(status, responseBody) {
  const error = responseBody && responseBody.error ? responseBody.error : {};
  const message = asText(error.message);
  const code = asText(error.code).toLowerCase();
  const lowerMessage = message.toLowerCase();

  if (status === 401) {
    return "OpenAI rejected the API key. Recreate the key, then update the OPENAI_API_KEY secret.";
  }

  if (status === 403 || lowerMessage.includes("permission") || lowerMessage.includes("not authorized")) {
    return "OpenAI blocked this request. Check that the key has Responses write access and access to the selected model.";
  }

  if (status === 404 || lowerMessage.includes("model")) {
    return "The selected OpenAI model is not available for this project yet. We need to switch the model setting.";
  }

  if (status === 429 || code.includes("quota") || lowerMessage.includes("quota") || lowerMessage.includes("billing")) {
    return "OpenAI billing or quota is not active for this project yet. Check the OpenAI billing and limits page.";
  }

  if (status === 400) {
    return "OpenAI did not accept the analyzer request format. I need to adjust the site code.";
  }

  if (status >= 500) {
    return "OpenAI had a temporary service problem. Try again in a few minutes.";
  }

  if (message) {
    const safeMessage = message.length > 220 ? `${message.slice(0, 217)}...` : message;
    return `OpenAI could not analyze the lesson: ${safeMessage}`;
  }

  return "OpenAI could not analyze the lesson yet. Please try again.";
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
  const normalized = {
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
  normalized.missingInformation = normalizeCurriculumMissingInformation(normalized);
  return normalized;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asText(item)).filter(Boolean);
}

function normalizeCurriculumMissingInformation(analysis) {
  return normalizeStringArray(analysis.missingInformation).filter((item) => {
    const text = item.toLowerCase();
    if (analysis.iCanStatement && (text.includes("i can") || text.includes("student-facing"))) return false;
    if (analysis.priorityStandard && text.includes("priority standard") && (text.includes("single") || text.includes("identify"))) return false;
    if (analysis.vocabulary.length && (text.includes("vocabulary") || text.includes("vocab"))) return false;
    if (analysis.familyQuestions.length && (text.includes("family") || text.includes("discussion question"))) return false;
    return true;
  });
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
